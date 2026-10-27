// netlify/functions/schedule.js
// 读取飞书「行程」表 + 「待审核行程」表中审核状态为「通过」的行，返回给前端
// （自动采集器写入的行程同样在这两张表里）

const NODE_TOKEN       = 'JNj8wQqEhiFGfIkr7UYc7ztrnpb';
const TABLE_ID         = 'tblY12iWOpwtIhJf'; // 行程表
const PENDING_TABLE_ID = 'tblSL3YruFJAfVjH'; // 待审核行程表
const APPROVED = ['通过', '已通过', '审核通过', '上线'];

// 飞书列名 → 代码字段映射（必须和你飞书表格列名完全一致）
const F = {
  date:     '日期',
  weekday:  '星期',
  time:     '时间',
  name:     '活动名称',
  type:     '活动类型',
  location: '地点',
  members:  '成员',
  note:     '备注',
  link:     '链接',
  status:   '审核状态',
};

const API = 'https://open.feishu.cn/open-apis';

async function feishu(path, token) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`${path.split('?')[0]} 失败: ${d.msg}`);
  return d.data;
}

async function readAll(appToken, tableId, token) {
  const items = [];
  let pageToken = '';
  do {
    const d = await feishu(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`,
      token,
    );
    items.push(...(d.items || []));
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return items;
}

function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.some(x => typeof x === 'object') ? v.map(x => x.text || x.name || '').join('') : v.join(','); // 富文本片段直接拼接；多选值用逗号
  if (typeof v === 'object') return v.text || v.link || '';
  return String(v);
}

function toDate(v) {
  if (typeof v === 'number') {
    // 飞书日期是 UTC 毫秒，加 8 小时取北京时间的日期
    return new Date(v + 8 * 3600e3).toISOString().slice(0, 10);
  }
  return text(v).trim();
}

const WDS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function toEvent(item) {
  const f = item.fields || {};
  const date = toDate(f[F.date]);
  let weekday = text(f[F.weekday]);
  if (!weekday && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split('-').map(Number);
    weekday = WDS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }
  const membersRaw = text(f[F.members]);
  const linkCell = f[F.link];
  return {
    date,
    weekday,
    time:     text(f[F.time]),
    name:     text(f[F.name]).trim(),
    type:     text(f[F.type]) || '其他',
    location: text(f[F.location]),
    members:  membersRaw ? membersRaw.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : ['全员'],
    note:     text(f[F.note]),
    link:     linkCell && typeof linkCell === 'object' && !Array.isArray(linkCell) ? linkCell.link || '' : text(linkCell),
  };
}

const key = e => e.date + '|' + e.name.toLowerCase().replace(/\s+/g, '');

export default async (req) => {
  const APP_ID     = Netlify.env.get('FEISHU_APP_ID');
  const APP_SECRET = Netlify.env.get('FEISHU_APP_SECRET');

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=120, stale-while-revalidate=300',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    const tokenRes = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) throw new Error('token 失败: ' + tokenData.msg);
    const token = tokenData.tenant_access_token;

    const node = await feishu(`/wiki/v2/spaces/get_node?token=${NODE_TOKEN}&obj_type=wiki`, token);
    const appToken = node.node.obj_token;

    const [main, pending] = await Promise.all([
      readAll(appToken, TABLE_ID, token),
      readAll(appToken, PENDING_TABLE_ID, token).catch(() => []),
    ]);
    const approved = pending.filter(i => APPROVED.includes(text(i.fields?.[F.status]).trim()));

    const seen = new Set();
    let skipped = 0;
    const events = [...main, ...approved]
      .map(toEvent)
      .filter(e => {
        if (!e.name || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) { skipped++; return false; }
        if (seen.has(key(e))) return false;
        seen.add(key(e));
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
      .map((e, i) => ({ id: i + 1, ...e }));

    return new Response(
      JSON.stringify({ events, count: events.length, skipped, updated: new Date().toISOString() }),
      { status: 200, headers },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, events: [] }), { status: 500, headers });
  }
};

export const config = { path: '/api/schedule' };
