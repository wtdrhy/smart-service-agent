/**
 * proxy-node.js — 零依赖本地反向代理（Node 内置模块实现）
 * ---------------------------------------------------------------
 * 用途：本地开发调试时绕过 DeepSeek 的 CORS 限制。
 *   node deploy/proxy-node.js
 *   然后把客服端「设置 → 反代地址」填成 http://localhost:8787/v1
 *
 * 说明：这只是本地开发用的便捷方案。要真正上线，请使用
 *       deploy/worker-proxy.js 部署到 Cloudflare Workers 等边缘函数平台。
 */
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8787;
const UPSTREAM_HOST = 'api.deepseek.com';
const UPSTREAM_PATH = '/chat/completions';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '仅代理 /chat/completions' }));
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const incoming = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const apiKey = process.env.DEEPSEEK_API_KEY || incoming;

    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '缺少 API Key（请求头 Authorization 或环境变量 DEEPSEEK_API_KEY）' }));
    }

    const proxyReq = https.request(
      {
        hostname: UPSTREAM_HOST,
        path: UPSTREAM_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
          'Content-Length': body.length,
        },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8' });
        upstream.pipe(res);
      }
    );

    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '上游请求失败: ' + e.message }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`\n  DeepSeek 反代已启动： http://localhost:${PORT}/v1`);
  console.log(`  在客服端「设置 → 反代地址」填入以上地址即可\n`);
});
