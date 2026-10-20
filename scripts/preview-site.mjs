import { createServer } from 'node:http';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const root = resolve('dist/site');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path === '/' || path === '/feedrelay') { response.writeHead(302, { Location: '/feedrelay/' }); response.end(); return; }
    if (!path.startsWith('/feedrelay/')) throw new Error();
    const relative = path.slice('/feedrelay/'.length) || 'index.html';
    if (relative.split('/').some(part => part.startsWith('.'))) throw new Error();
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep) || !(await lstat(file)).isFile()) throw new Error();
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(404); response.end('Not found'); }
});
let port = Number(process.env.SITE_PORT ?? 5190);
let retries = 0;
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && retries++ < 10 && port !== 0) { server.listen(++port, '127.0.0.1'); return; }
  console.error('SITE_PREVIEW_UNAVAILABLE'); process.exitCode = 1;
});
server.on('listening', () => console.log(`FeedRelay site: http://127.0.0.1:${server.address().port}/feedrelay/`));
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
process.on('SIGINT', () => { server.closeAllConnections(); server.close(); });
