// Local preview: serves the site and runs the real Worker against a fake GitHub
// that stores everything in dev/.data/. No accounts or tokens needed.
//
//   node dev/server.mjs            → http://localhost:8787
//   Admin key: dev-admin           (open http://localhost:8787/?admin)
//   Set REVIEW_CODE=xyz to try the client code gate.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from '../worker/worker.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(root, '..', 'docs');
const dataDir = path.join(root, '.data');
const PORT = Number(process.env.PORT || 8787);

const env = {
  GITHUB_TOKEN: 'dev', GITHUB_OWNER: 'dev', GITHUB_REPO: 'dev', GITHUB_BRANCH: 'review-data',
  ADMIN_KEY: process.env.ADMIN_KEY || 'dev-admin',
  REVIEW_CODE: process.env.REVIEW_CODE || '',
  ALLOWED_ORIGINS: '*', PUBLIC_IMAGES: 'false',
};

// ---- fake GitHub Contents API, backed by dev/.data ----
const realFetch = globalThis.fetch;
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  if (u.hostname !== 'api.github.com') return realFetch(url, init);
  const rel = decodeURIComponent(u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ''));
  const file = path.join(dataDir, rel);
  if (!file.startsWith(dataDir)) return new Response('{}', { status: 400 });
  const method = init.method || 'GET';
  const existing = await fs.readFile(file).catch(() => null);
  if (method === 'GET') {
    if (!existing) return new Response('{}', { status: 404 });
    if (String(init.headers?.Accept).includes('raw')) return new Response(existing);
    return Response.json({ sha: sha(existing), encoding: 'base64', content: existing.toString('base64') });
  }
  const body = JSON.parse(init.body);
  if (method === 'PUT') {
    if (existing && body.sha !== sha(existing)) return new Response('{}', { status: 409 });
    const buf = Buffer.from(body.content, 'base64');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);
    return Response.json({ content: { sha: sha(buf) } });
  }
  if (method === 'DELETE') {
    if (!existing) return new Response('{}', { status: 404 });
    await fs.unlink(file);
    return Response.json({});
  }
  return new Response('{}', { status: 405 });
};

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/img/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(`window.REVIEW_CONFIG = { apiUrl: 'http://localhost:${PORT}' };`);
    return;
  }
  const file = path.join(site, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(site)) { res.writeHead(400); return res.end(); }
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Screenshot Review running at http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/?admin   key: ${env.ADMIN_KEY}${env.REVIEW_CODE ? `   review code: ${env.REVIEW_CODE}` : ''}`);
});
