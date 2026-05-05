// netlify/functions/debug.js
// 临时调试用，上线后可以删掉

export default async (req, context) => {
  const APP_ID     = Netlify.env.get('FEISHU_APP_ID');
  const APP_SECRET = Netlify.env.get('FEISHU_APP_SECRET');

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };

  // 1. 检查环境变量是否存在
  const diagnosis = {
    app_id_exists:     !!APP_ID,
    app_secret_exists: !!APP_SECRET,
    app_id_length:     APP_ID ? APP_ID.length : 0,
    app_secret_length: APP_SECRET ? APP_SECRET.length : 0,
    app_id_prefix:     APP_ID ? APP_ID.slice(0, 6) : 'MISSING',  // 只显示前6位，不暴露完整值
    app_id_has_spaces: APP_ID ? (APP_ID !== APP_ID.trim()) : null,
    app_secret_has_spaces: APP_SECRET ? (APP_SECRET !== APP_SECRET.trim()) : null,
  };

  // 2. 尝试获取 token
  let tokenResult = null;
  if (APP_ID && APP_SECRET) {
    try {
      const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: APP_ID.trim(),
          app_secret: APP_SECRET.trim(),
        }),
      });
      const data = await res.json();
      tokenResult = {
        code: data.code,
        msg:  data.msg,
        token_exists: !!data.tenant_access_token,
      };
    } catch (e) {
      tokenResult = { error: e.message };
    }
  }

  return new Response(
    JSON.stringify({ diagnosis, tokenResult }, null, 2),
    { status: 200, headers }
  );
};

export const config = { path: '/api/debug' };
