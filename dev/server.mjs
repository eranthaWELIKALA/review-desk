// Local preview: serves the site and runs the real Worker against a fake GitHub
// (dev/fake-github.mjs) saved to dev/.data/github.json. No accounts or tokens needed.
//
//   node dev/server.mjs            → http://localhost:8787
//   Site admin key: dev-admin      (open http://localhost:8787/#/admin)
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/worker.js';
import { createFakeGitHub, installFakeGitHub } from './fake-github.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(root, '..', 'docs');
const dataFile = path.join(root, '.data', 'github.json');
const PORT = Number(process.env.PORT || 8787);

const env = {
  GITHUB_TOKEN: 'dev', GITHUB_OWNER: 'dev', GITHUB_REPO: 'dev', GITHUB_BRANCH: 'review-data',
  ADMIN_KEY: process.env.ADMIN_KEY || 'dev-admin',
  SPACE_SECRET: 'dev-space-secret',
  ALLOWED_ORIGINS: '*',
  DEMO_PER_IP_PER_DAY: '50',
};

let saved = null;
try { saved = JSON.parse(readFileSync(dataFile, 'utf8')); } catch { /* first run */ }
let timer;
const fake = createFakeGitHub({
  state: saved,
  onChange: () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      mkdirSync(path.dirname(dataFile), { recursive: true });
      writeFileSync(dataFile, JSON.stringify(fake.serialize()));
    }, 300);
  },
});
installFakeGitHub(fake);

// Same schedule as production would be too slow to try out; run cleanup every minute.
setInterval(() => worker.scheduled({}, env, { waitUntil: () => {} }), 60_000);

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
  console.log(`Review Desk running at http://localhost:${PORT}`);
  console.log(`Site admin: http://localhost:${PORT}/#/admin   key: ${env.ADMIN_KEY}`);
});
