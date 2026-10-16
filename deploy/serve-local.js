/**
 * serve-local.js — 零依赖本地静态预览服务器
 * ---------------------------------------------------------------
 * 用途：本地打开项目（不建议直接双击 html，部分浏览器会限制 file:// 下的 localStorage）
 *   node deploy/serve-local.js [端口]
 *   然后访问 http://localhost:8123
 *
 * 之所以不用 python -m http.server：它是单线程的，浏览器并发加载多个脚本时
 * 会出现 "Could not load script" 之类的超时错误。本实现基于 Node 异步 IO，无此问题。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.sql': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

http
  .createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html';

    const filePath = path.join(ROOT, pathname);
    // 防目录穿越
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found: ' + pathname);
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`\n  智能客服 Agent 本地服务已启动`);
    console.log(`  客服对话端： http://localhost:${PORT}/index.html`);
    console.log(`  管理后台：   http://localhost:${PORT}/admin.html`);
    console.log(`  根目录：     ${ROOT}\n`);
  });
