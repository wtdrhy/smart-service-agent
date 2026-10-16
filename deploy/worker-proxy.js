/**
 * worker-proxy.js — Cloudflare Worker 反向代理（解决 DeepSeek 的 CORS 限制）
 * ---------------------------------------------------------------
 * 为什么需要它：
 *   DeepSeek 官方端点 api.deepseek.com 不返回 Access-Control-Allow-Origin，
 *   浏览器直接 fetch 会被同源策略拦截（控制台报 CORS 错误）。
 *   纯静态部署没有自己的后端，因此用一个 20 行的边缘函数做转发。
 *
 * 部署步骤（免费额度足够个人项目）：
 *   1. 注册 cloudflare.com → Workers & Pages → 创建 Worker
 *   2. 把本文件内容粘进编辑器，部署
 *   3. 把得到的地址（如 https://ssa-proxy.xxx.workers.dev）填到
 *      客服端「设置 → 反代地址」，注意保留 /v1 之前的部分
 *
 * 安全建议（生产环境务必做）：
 *   · 把 ALLOW_ORIGIN 从 '*' 改成你自己的域名
 *   · 把 Key 存到 Worker 的环境变量 DEEPSEEK_API_KEY，前端不再传 Key
 *   · 加上速率限制，防止被盗刷
 */

const UPSTREAM = 'https://api.deepseek.com';

// 生产环境请改成你的实际域名，例如 'https://your-site.pages.dev'
const ALLOW_ORIGIN = '*';

function withCors(res) {
  res.headers.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.headers.set('Access-Control-Max-Age', '86400');
  return res;
}

function json(obj, status = 200) {
  return withCors(
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
  );
}

export default {
  async fetch(request, env) {
    // 预检请求
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (!url.pathname.endsWith('/chat/completions')) {
      return json({ error: '仅代理 /chat/completions' }, 404);
    }

    // 优先使用 Worker 环境变量里的 Key（生产推荐），否则透传前端传来的 Key
    const incoming = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const apiKey = env.DEEPSEEK_API_KEY || incoming;
    if (!apiKey) {
      return json({ error: '缺少 API Key' }, 401);
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(UPSTREAM + url.pathname, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        // 直接透传请求体，天然支持 stream: true 的流式返回
        body: await request.text(),
      });
    } catch (e) {
      return json({ error: '上游请求失败: ' + e.message }, 502);
    }

    const body = await upstreamRes.text();
    return withCors(
      new Response(body, {
        status: upstreamRes.status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  },
};
