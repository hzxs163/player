#!/usr/bin/env node
// 本地开发服务器：静态目录 + 与 GitHub Pages 一致的 CORS 头。
// .gz 文件按原始字节发出（不设 Content-Encoding），浏览器侧自己用 DecompressionStream 解，
// 这样本地和线上的下载体积、进度条口径完全一样。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || process.argv[2] || 8123);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gz': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`404 ${rel}\n根目录：${ROOT}`);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': st.size,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
    res.on('error', () => res.destroy());
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`拾波开发服务器 http://127.0.0.1:${PORT}/  （根目录 ${ROOT}）`);
});
