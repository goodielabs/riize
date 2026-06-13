// netlify/functions/discussion.js
// 讨论贴 CRUD,数据存于飞书「讨论贴」表 (tblUyYB8oH66hBsy)
// 与 schedule.js 复用相同的 NODE_TOKEN / env vars / 鉴权流程

const NODE_TOKEN = 'JNj8wQqEhiFGfIkr7UYc7ztrnpb';
const TABLE_ID   = 'tblUyYB8oH66hBsy';

// 飞书列名(必须和你飞书表里列名完全一致)
const F = {
  name:       'name',
  content:    'content',
  parent_id:  'parent_id',
  likes:      'likes',
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

function toPost(item) {
  const f = item.fields || {};
  const status = String(readField(f, 'status') || '已发布');
  if (status === '已删除') return null;
  return {
    id: item.record_id,
    name: String(readField(f, 'name') || '匿名 BRIIZE'),
    content: String(readField(f, 'content') || ''),
    parent_id: String(readField(f, 'parent_id') || '') || null,
    likes: Number(readField(f, 'likes')) || 0,
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

    // GET → 列出所有未删除的帖子
    if (req.method === 'GET') {
      const items = await listRecords(token, appToken);
      const posts = items.map(toPost).filter(Boolean).sort((a, b) => b.ts - a.ts);
      return new Response(JSON.stringify({ posts, count: posts.length }), {
        status: 200,
        headers: { ...headers, 'Cache-Control': 'public, max-age=10, stale-while-revalidate=30' },
      });
    }

    if (req.method !== 'POST')
      return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });

    const body = await req.json();
    const action = body.action;

    // POST {action:'create', name, content, parent_id?} → 新建帖子/回复
    if (action === 'create') {
      if (!body.content) return new Response(JSON.stringify({ error: '内容不能为空' }), { status: 400, headers });
      const fields = {
        [F.name]:    String(body.name || '匿名 BRIIZE').slice(0, 32),
        [F.content]: String(body.content).slice(0, 500),
        [F.likes]:   0,
      };
      if (body.parent_id) fields[F.parent_id] = String(body.parent_id);
      // status 由飞书默认值"已发布"自动填充

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

    // POST {action:'like', id, direction:1|-1} → 点赞/取消
    if (action === 'like') {
      const recId = String(body.id || '');
      if (!recId) return new Response(JSON.stringify({ error: '缺少 id' }), { status: 400, headers });
      const dir = body.direction === -1 ? -1 : 1;

      const gr = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${TABLE_ID}/records/${recId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const gd = await gr.json();
      if (gd.code !== 0) throw new Error('like-read: ' + gd.msg);
      const cur = Number(gd.data.record.fields[F.likes] || 0);
      const next = Math.max(0, cur + dir);

      const pr = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${TABLE_ID}/records/${recId}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { [F.likes]: next } }),
        }
      );
      const pd = await pr.json();
      if (pd.code !== 0) throw new Error('like-write: ' + pd.msg);
      return new Response(JSON.stringify({ likes: next, ok: true }), { status: 200, headers });
    }

    // POST {action:'delete', id} → 软删除(status="已删除")
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

export const config = { path: '/api/discussion' };
