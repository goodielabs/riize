// netlify/functions/news.js
// 读取飞书「新闻」表（由自动采集器写入），按发布时间倒序返回最近的新闻

const NODE_TOKEN = 'JNj8wQqEhiFGfIkr7UYc7ztrnpb';
const NEWS_TABLE_NAME = '新闻';
const LIMIT = 60;
const API = 'https://open.feishu.cn/open-apis';

async function feishu(path, token) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`${path.split('?')[0]} 失败: ${d.msg}`);
  return d.data;
}

const text = v => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.some(x => typeof x === 'object') ? v.map(x => x.text || x.name || '').join('') : v.join(','); // 富文本片段直接拼接；多选值用逗号
  if (typeof v === 'object') return v.text || v.link || '';
  return String(v);
};

export default async () => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
  };
  try {
    const t = await (await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: Netlify.env.get('FEISHU_APP_ID'), app_secret: Netlify.env.get('FEISHU_APP_SECRET') }),
    })).json();
    if (t.code !== 0) throw new Error('token 失败: ' + t.msg);
    const token = t.tenant_access_token;
    const appToken = (await feishu(`/wiki/v2/spaces/get_node?token=${NODE_TOKEN}&obj_type=wiki`, token)).node.obj_token;

    const tables = (await feishu(`/bitable/v1/apps/${appToken}/tables?page_size=100`, token)).items || [];
    const table = tables.find(x => x.name === NEWS_TABLE_NAME);
    if (!table) return new Response(JSON.stringify({ news: [], count: 0 }), { status: 200, headers });

    const items = [];
    let pageToken = '';
    do {
      const d = await feishu(
        `/bitable/v1/apps/${appToken}/tables/${table.table_id}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`,
        token,
      );
      items.push(...(d.items || []));
      pageToken = d.has_more ? d.page_token : '';
    } while (pageToken);

    const news = items
      .map(i => {
        const f = i.fields || {};
        if (f['隐藏'] === true) return null; // 在飞书里加一列「隐藏」(复选框) 可手动下架
        const link = f['链接'];
        return {
          title: text(f['标题']),
          summary: text(f['摘要']),
          link: link && typeof link === 'object' && !Array.isArray(link) ? link.link : text(link),
          source: text(f['来源']),
          category: text(f['分类']) || '其他',
          importance: Number(f['重要度']) || 1,
          published: Number(f['发布时间']) || 0,
        };
      })
      .filter(n => n && n.title)
      .sort((a, b) => b.published - a.published)
      .slice(0, LIMIT);

    return new Response(JSON.stringify({ news, count: news.length }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, news: [] }), { status: 500, headers });
  }
};

export const config = { path: '/api/news' };
