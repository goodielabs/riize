// netlify/functions/schedule.js
// 读取飞书「行程」表，返回给前端

const NODE_TOKEN    = 'JNj8wQqEhiFGfIkr7UYc7ztrnpb'; // wiki URL 中 /wiki/ 后的部分
const TABLE_ID      = '';  // ← 部署后从飞书表格 URL 里获取 table=tblXXXXX，填在这里

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
};

export default async (req, context) => {
  const APP_ID     = Netlify.env.get('FEISHU_APP_ID');
  const APP_SECRET = Netlify.env.get('FEISHU_APP_SECRET');

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    // 1. 获取 tenant_access_token
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) throw new Error('token 失败: ' + tokenData.msg);
    const token = tokenData.tenant_access_token;

    // 2. node_token → app_token
    const nodeRes = await fetch(
      `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${NODE_TOKEN}&obj_type=wiki`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const nodeData = await nodeRes.json();
    if (nodeData.code !== 0) throw new Error('node 失败: ' + nodeData.msg);
    const appToken = nodeData.data.node.obj_token;

    // 3. 分页读取记录
    const allItems = [];
    let pageToken = '';
    do {
      const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${TABLE_ID}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
      const recRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const recData = await recRes.json();
      if (recData.code !== 0) throw new Error('读取记录失败: ' + recData.msg);
      allItems.push(...(recData.data.items || []));
      pageToken = recData.data.page_token || '';
    } while (pageToken);

    // 4. 字段转换
    const events = allItems.map((item, i) => {
      const f = item.fields || {};
      const get = (key) => {
        const v = f[F[key]];
        if (v == null) return '';
        if (Array.isArray(v)) return v.map(x => x.text || x.name || String(x)).join('');
        if (key === 'date' && typeof v === 'number') {
          const d = new Date(v);
          return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        }
        if (typeof v === 'object' && v.text) return v.text;
        return String(v);
      };

      // 成员字段：逗号分隔 → 数组
      const membersRaw = get('members');
      const members = membersRaw
        ? membersRaw.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
        : ['全员'];

      // 日期 → 自动算星期
      const dateStr = get('date');
      let weekday = get('weekday');
      if (!weekday && dateStr) {
        const wds = ['周日','周一','周二','周三','周四','周五','周六'];
        const [y,m,d] = dateStr.split('-').map(Number);
        weekday = wds[new Date(y, m-1, d).getDay()];
      }

      return {
        id: i + 1,
        date: dateStr,
        weekday,
        time:     get('time'),
        name:     get('name'),
        type:     get('type') || '其他',
        location: get('location'),
        members,
        note:     get('note'),
        link:     get('link'),
      };
    }).filter(e => e.name && e.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    return new Response(
      JSON.stringify({ events, count: events.length, updated: new Date().toISOString() }),
      { status: 200, headers }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, events: [] }), { status: 500, headers });
  }
};

export const config = { path: '/api/schedule' };
