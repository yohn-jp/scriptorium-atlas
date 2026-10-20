import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const profile = process.argv[2] ?? 'combined';
if (!['atlas', 'story', 'combined'].includes(profile)) throw new Error('Use atlas, story or combined');
const root = resolve(fileURLToPath(new URL(`../../../dist/${profile}/`, import.meta.url)));
const hostPort = Number(process.env.ATLAS_HOST_PORT ?? 4173);
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65533) throw new Error('ATLAS_HOST_PORT must be 1024–65533');
const atlasPort = hostPort + 1;
const storyPort = hostPort + 2;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };

function serve(port, plugin) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = plugin ? '/frame.html' : '/index.html';
      if (path.includes('\0') || path.includes('\\')) throw new Error('Invalid path');
      if (path.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Invalid path');
      const file = resolve(root, `.${path}`);
      if (!file.startsWith(root + sep) && file !== root) throw new Error('Invalid path');
      if (plugin && path === '/index.html' || !plugin && path === '/frame.html') { res.writeHead(403); res.end(); return; }
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Not a file');
      // Official Excalidraw reads self-hosted font bytes with fetch before FontFace.
      const fontConnect = plugin === 'atlas' ? `http://127.0.0.1:${port}/fonts/` : "'none'";
      const csp = ["default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data:", "font-src 'self' data:", "worker-src 'self' blob:", `connect-src ${fontConnect}`, "object-src 'none'", "base-uri 'none'", "form-action 'none'", plugin ? `frame-ancestors http://127.0.0.1:${hostPort}` : `frame-src http://127.0.0.1:${atlasPort} http://127.0.0.1:${storyPort}`].join('; ');
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`${plugin ?? 'host'} http://127.0.0.1:${port}\n`));
  return server;
}
const servers = [serve(hostPort, null)];
if (profile !== 'story') servers.push(serve(atlasPort, 'atlas'));
if (profile !== 'atlas') servers.push(serve(storyPort, 'story'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const server of servers) server.close(); });
