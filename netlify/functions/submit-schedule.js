// netlify/functions/submit-schedule.js
// 接收投稿，写入飞书「待审核行程」表

const NODE_TOKEN        = 'JNj8wQqEhiFGfIkr7UYc7ztrnpb';
const PENDING_TABLE_ID  = ''; // ← 待审核行程表的 table_id，从飞书 URL 获取

// 列名映射（必须和你的待审核表列名一致）
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
  submitted:'提交时间',
};

export default async (req, context) => {
  const APP_ID     = Netlify.env.get('FEISHU_APP_ID');
  const APP_SECRET = Netlify.env.get('FEISHU_APP_SECRET');

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });

  try {
    const payload = await req.json();
    if (!payload.name || !payload.date) {
      return new Response(JSON.stringify({ error: '缺少必填字段' }), { status: 400, headers });
    }

    // 1. token
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) throw new Error('token: ' + tokenData.msg);
    const token = tokenData.tenant_access_token;

    // 2. node → app token
    const nodeRes = await fetch(
      `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${NODE_TOKEN}&obj_type=wiki`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const nodeData = await nodeRes.json();
    if (nodeData.code !== 0) throw new Error('node: ' + nodeData.msg);
    const appToken = nodeData.data.node.obj_token;

    // 3. 构造 fields
    const fields = {};
    const put = (k, v) => { if (v) fields[F[k]] = v; };

    // 日期 → 时间戳（毫秒）
    if (payload.date) {
      const ts = new Date(payload.date + 'T12:00:00').getTime();
      if (!isNaN(ts)) fields[F.date] = ts;
    }

    // 星期自动计算
    const wds = ['周日','周一','周二','周三','周四','周五','周六'];
    const [y,m,d] = payload.date.split('-').map(Number);
    fields[F.weekday] = wds[new Date(y,m-1,d).getDay()];

    put('time',     payload.time);
    put('name',     payload.name);
    put('type',     payload.type || '其他');
    put('location', payload.location);
    put('members',  payload.members || '全员');
    put('note',     payload.note);
    put('link',     payload.link);
    fields[F.status]    = '待审核';
    fields[F.submitted] = Date.now();

    // 4. 写入飞书
    const writeRes = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${PENDING_TABLE_ID}/records`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      }
    );
    const writeData = await writeRes.json();
    if (writeData.code !== 0) throw new Error('写入失败: ' + writeData.msg);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/api/submit-schedule' };
