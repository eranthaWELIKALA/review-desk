// Shared test setup: the Worker against an in-memory fake GitHub, an in-memory D1,
// and Clerk-style session tokens signed with a local RSA key.
import { generateKeyPairSync, createSign } from 'node:crypto';
import worker from '../worker.js';
import { createFakeGitHub, installFakeGitHub } from '../../dev/fake-github.mjs';
import { createFakeD1 } from '../../dev/fake-d1.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const ISSUER = 'https://test.clerk.accounts.dev';
export const ORIGIN = 'https://x.github.io';

export const baseEnv = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'review-data',
  SPACE_SECRET: 'space-secret', ALLOWED_ORIGINS: ORIGIN,
  SITE_URL: 'https://x.github.io/review-desk/',
  CLERK_ISSUER: ISSUER, CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  SITE_ADMIN_EMAILS: 'admin@example.com',
  DEMO_QUOTA_MB: '0.001', // 1 KB-ish, so tests can fill it
  // The in-memory rate limits are shared by every call in a test; keep them out of the way.
  RATE_AUTH_PER_MIN: '100000', RATE_WRITES_PER_MIN: '100000',
};

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** A Clerk v2 session token. `claims` overrides any default (iss, azp, exp, fva, …). */
export function token(user, claims = {}, key = privateKey) {
  const t = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT', kid: 'test' });
  const body = b64url({
    iss: ISSUER, sub: user.id, azp: ORIGIN, iat: t, nbf: t - 5, exp: t + 60, sid: 'sess_1', v: 2, sts: 'active',
    email: user.email, name: user.name ?? '', fva: [0, user.mfa ? 0 : -1], ...claims,
  });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export const ADMIN = { id: 'user_admin', email: 'admin@example.com', name: 'Site Admin', mfa: true };
export const user = (name, extra = {}) => ({ id: `user_${name}`, email: `${name}@example.com`, name: name[0].toUpperCase() + name.slice(1), ...extra });

export function setup(extraEnv = {}) {
  const gh = createFakeGitHub();
  const restore = installFakeGitHub(gh);
  const db = createFakeD1();
  const env = { ...baseEnv, DB: db, ...extraEnv };
  const sent = []; // emails "sent" through the fake Resend
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const body = JSON.parse(init.body);
      if (env.RESEND_FAIL) return new Response('{"message":"nope"}', { status: 403 });
      sent.push(body);
      return Response.json({ id: `email_${sent.length}` });
    }
    return realFetch(url, init);
  };

  async function call(method, path, { body, site, as, auth, key, code, ip = '1.1.1.1', headers: extra = {} } = {}) {
    const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...extra };
    if (site) as = ADMIN;
    if (as) headers.Authorization = `Bearer ${token(as)}`;
    if (auth) headers.Authorization = auth;
    if (key) headers['X-Space-Key'] = key;
    if (code) headers['X-Review-Code'] = code;
    const res = await worker.fetch(new Request(`https://w.dev${path}`, {
      method, headers, body: typeof body === 'string' || body instanceof ReadableStream ? body : body ? JSON.stringify(body) : undefined,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    }), env);
    const type = res.headers.get('Content-Type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.arrayBuffer() };
  }
  return {
    gh, db, env, call, sent,
    restore: () => { globalThis.fetch = realFetch; restore(); },
  };
}

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
export const pngBody = (filename = 'Login Screen.PNG', extra = {}) => ({ filename, data: 'data:image/png;base64,' + PNG.toString('base64'), ...extra });

/** A signed-in user requests a space and the admin approves it. */
export async function approvedSpace(call, owner, { title = 'Mango' } = {}) {
  const { data: req } = await call('POST', '/api/requests', { as: owner, body: { organization: title, purpose: 'Sprint reviews' } });
  const { data } = await call('POST', `/api/admin/requests/${req.id}/approve`, { site: true, body: { quotaMb: 1 } });
  return { requestId: req.id, ...data };
}
