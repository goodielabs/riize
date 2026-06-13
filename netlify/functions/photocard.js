// netlify/functions/photocard.js
// 小卡交换 CRUD,数据存于飞书「小卡交换」表 (tblVE7I6oU38Zu7p)
// 与 schedule.js 复用相同的 NODE_TOKEN / env vars / 鉴权流程

const NODE_TOKEN = 'JNj8wQqEhiFGfIkr7UYc7ztrnpb';
const TABLE_ID   = 'tblVE7I6oU38Zu7p';

// 飞书列名(必须和你飞书表里列名完全一致)
const F = {
  handle:     'handle',
  contact:    'contact',
  have_text:  'have_text',
  want_text:  'want_text',
  region:     'region',
  status:     'status',
  created_at: 'created_at',
};

/* ---------- helpers ---------- */
async function getToken(APP_ID, APP_SECRET) {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('token: ' + d.msg);
  return d.tenant_access_token;
}

async function getAppToken(token) {
  const r = await fetch(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${NODE_TOKEN}&obj_type=wiki`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  if (d.code !== 0) throw new Error('node: ' + d.msg);
  return d.data.node.obj_token;
}

async function listRecords(token, appToken) {
  const all = [];
  let pt = '';
  do {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${TABLE_ID}/records?page_size=500${pt ? '&page_token=' + pt : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (d.code !== 0) throw new Error('list: ' + d.msg);
    all.push(...(d.data.items || []));
    pt = d.data.page_token || '';
  } while (pt);
  return all;
}

function readField(fields, key) {
  const v = fields[F[key]];
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => x.text || x.name || String(x)).join('');
  if (typeof v === 'object' && v.text) return v.text;
  return v;
}

function toListing(item) {
  const f = item.fields || {};
  const status = String(readField(f, 'status') || '已发布');
  if (status === '已删除') return null;
  return {
    id: item.record_id,
    handle:  String(readField(f, 'handle') || ''),
    contact: String(readField(f, 'contact') || ''),
    have:    String(readField(f, 'have_text') || ''),
    want:    String(readField(f, 'want_text') || ''),
    region:  String(readField(f, 'region') || ''),
    ts: Number(f[F.created_at]) || Date.now(),
  };
}

/* ---------- handler ---------- */
export default async (req) => {
  const APP_ID     = Netlify.env.get('FEISHU_APP_ID');
  const APP_SECRET = Netlify.env.get('FEISHU_APP_SECRET');

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    const token = await getToken(APP_ID, APP_SECRET);
    const appToken = await getAppToken(token);

    // GET → 列出所有未删除挂帖
    if (req.method === 'GET') {
      const items = await listRecords(token, appToken);
      const listings = items.map(toListing).filter(Boolean).sort((a, b) => b.ts - a.ts);
      return new Response(JSON.stringify({ listings, count: listings.length }), {
        status: 200,
        headers: { ...headers, 'Cache-Control': 'public, max-age=10, stale-while-revalidate=30' },
      });
    }

    if (req.method !== 'POST')
      return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });

    const body = await req.json();
    const action = body.action;

    // POST {action:'create', handle, contact, have_text, want_text, region} → 新建挂帖
    if (action === 'create') {
      if (!body.handle || !body.have_text || !body.want_text)
        return new Response(JSON.stringify({ error: '缺少必填字段' }), { status: 400, headers });

      const fields = {
        [F.handle]:    String(body.handle).slice(0, 64),
        [F.have_text]: String(body.have_text).slice(0, 500),
        [F.want_text]: String(body.want_text).slice(0, 500),
      };
      if (body.contact) fields[F.contact] = String(body.contact).slice(0, 200);
      if (body.region)  fields[F.region]  = String(body.region).slice(0, 100);

      const r = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${TABLE_ID}/records`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields }),
        }
      );
      const d = await r.json();
      if (d.code !== 0) throw new Error('create: ' + d.msg);
      return new Response(JSON.stringify({ id: d.data.record.record_id, ok: true }), { status: 200, headers });
    }

    // POST {action:'delete', id} → 软删除
    if (action === 'delete') {
      const recId = String(body.id || '');
      if (!recId) return new Response(JSON.stringify({ error: '缺少 id' }), { status: 400, headers });
      const r = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${TABLE_ID}/records/${recId}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { [F.status]: '已删除' } }),
        }
      );
      const d = await r.json();
      if (d.code !== 0) throw new Error('delete: ' + d.msg);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/api/photocard' };
