// Local preview: serves the site and runs the real Worker against a fake GitHub
// (dev/fake-github.mjs, saved to dev/.data/github.json), a SQLite stand-in for D1
// (dev/.data/d1.sqlite) and a stand-in for Clerk (dev/fake-clerk.js). No accounts
// or tokens needed. Emails are printed here instead of being sent.
//
//   node dev/server.mjs            → http://localhost:8787
//   Sign in as admin@dev.local (with two-step verification) for the admin console.
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/worker.js';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createFakeGitHub, installFakeGitHub } from './fake-github.mjs';
import { createFakeD1 } from './fake-d1.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(root, '..', 'docs');
const dataFile = path.join(root, '.data', 'github.json');
const PORT = Number(process.env.PORT || 8787);

mkdirSync(path.join(root, '.data'), { recursive: true });
// A fresh signing key per run: dev sign-ins last until the server restarts.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISSUER = `http://localhost:${PORT}/dev-clerk`;

const env = {
  GITHUB_TOKEN: 'dev', GITHUB_OWNER: 'dev', GITHUB_REPO: 'dev', GITHUB_BRANCH: 'review-data',
  SPACE_SECRET: 'dev-space-secret',
  ALLOWED_ORIGINS: '*',
  SITE_URL: `http://localhost:${PORT}/`,
  CLERK_ISSUER: ISSUER,
  CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  SITE_ADMIN_EMAILS: 'admin@dev.local',
  RESEND_API_KEY: 'dev', EMAIL_FROM: 'Review Desk <dev@localhost>',
  DB: createFakeD1(path.join(root, '.data', 'd1.sqlite')),
  DEMO_PER_IP_PER_DAY: '50',
};

// Emails are printed instead of sent.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    const m = JSON.parse(init.body);
    console.log(`\n--- email to ${m.to.join(', ')}: ${m.subject}\n${m.text}\n---\n`);
    return Response.json({ id: 'dev' });
  }
  return realFetch(url, init);
};

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function devToken(u, origin) {
  const t = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT', kid: 'dev' });
  const body = b64url({ iss: ISSUER, sub: u.id, azp: origin, iat: t, nbf: t - 5, exp: t + 60, v: 2, sts: 'active', email: u.email, name: u.name || '', fva: [0, u.mfa ? 0 : -1] });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')}`;
}

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
    res.end(`window.REVIEW_CONFIG = { apiUrl: 'http://localhost:${PORT}', clerkPublishableKey: 'dev' };`);
    return;
  }
  if (url.pathname === '/dev-clerk.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(await fs.readFile(path.join(root, 'fake-clerk.js')));
    return;
  }
  if (url.pathname === '/dev-clerk/token' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const u = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: devToken(u, req.headers.origin || `http://localhost:${PORT}`) }));
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
  console.log(`Site admin: http://localhost:${PORT}/#/admin   sign in as admin@dev.local (say yes to two-step verification)`);
});
