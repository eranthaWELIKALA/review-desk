/**
 * Review Desk API — Cloudflare Worker
 *
 * The GitHub Pages site is static, so it can't hold a GitHub token. This Worker
 * holds it and does every write. Everything is stored as files in a private repo:
 *
 *   review-data branch — approved spaces (kept, versioned in git history)
 *     registry/spaces.json              approved spaces (title, owner)
 *     registry/requests.json            requests for a space (name, email, purpose)
 *     spaces/<id>/index.json            space settings, title, section order, storage used
 *     spaces/<id>/sections/<sid>.json   a section, its images and its comments
 *     spaces/<id>/images/<sid>/<file>   the screenshots
 *
 *   demo-data branch — demo spaces, same layout. The hourly cleanup deletes expired
 *   demos and rewrites this branch without history, so their files really go away.
 *     registry/demos.json               demos started in the last day (for rate limits)
 *
 * Who can do what:
 *   site admin    X-Admin-Session: as.<exp>.<mac>  approve requests, manage every space
 *                 (from POST /api/admin/session with ADMIN_KEY, plus a TOTP code
 *                 when ADMIN_TOTP_SECRET is set; valid for one hour)
 *   space admin   X-Space-Key: sk-<id>-<mac>       upload, edit, resolve in one space
 *   reviewer      X-Review-Code: per-space code    view and comment in one space
 *   images        /img/…?t=<exp>.<mac>             short-lived token from /me, so the
 *                                                  review code never goes in a URL
 * Space keys and review codes are HMACs of the space id under SPACE_SECRET, so no
 * secret is written to the repo. Bumping keyVersion / codeVersion rotates them.
 * Admin sessions, image tokens and the IP salt use their own keys derived from
 * SPACE_SECRET with HKDF.
 *
 * Abuse controls: wrong credentials and writes are rate limited per IP (the
 * AUTH_LIMIT and WRITE_LIMIT bindings, or an in-memory fallback), and demo and
 * request creation need a Turnstile token when TURNSTILE_SECRET is set.
 *
 * Secrets:  GITHUB_TOKEN, ADMIN_KEY, SPACE_SECRET, ADMIN_TOTP_SECRET (optional),
 *           TURNSTILE_SECRET (optional)
 * Vars:     GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, DEMO_BRANCH, ALLOWED_ORIGINS,
 *           DEMO_ENABLED, DEMO_QUOTA_MB, DEMO_HOURS, DEMO_MAX_ACTIVE, DEMO_PER_IP_PER_DAY,
 *           SPACE_QUOTA_MB, MAX_PENDING_REQUESTS, TURNSTILE_SITE_KEY,
 *           RATE_AUTH_PER_MIN, RATE_WRITES_PER_MIN (in-memory fallback only)
 */

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * MB;
const MAX_COMMENT = 2000;
const MAX_NAME = 60;
// Opening a space reads every section file, and the Workers free plan allows 50
// GitHub calls per request, so keep this comfortably below that.
const MAX_SECTIONS = 40;
const MAX_IMAGES_PER_SECTION = 200;
const MAX_COMMENTS_PER_SECTION = 1000;
const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
const ID_RE = /^[a-z0-9]{6,40}$/;
const SPACE_RE = /^[sd][a-z0-9]{10,30}$/;          // s… = approved space, d… = demo
const IMAGE_REL_RE = /^[a-z0-9]{6,40}\/[a-z0-9]{6,40}-[a-z0-9-]{1,50}\.(png|jpg|gif|webp)$/;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
// Review code scheme 2: 12 characters (~59 bits) without modulo bias. Spaces
// created before it keep their 8-character code until it is rotated.
const CODE_SCHEME = 2;
const ADMIN_SESSION_MS = 60 * 60e3;
const IMAGE_TOKEN_STEP_MS = 12 * 3600e3; // tokens last 12–24 h and stay stable for 12 h, so images cache
// Magic bytes for each upload type, so a file can't pretend to be an image.
const IMAGE_MAGIC = {
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => String.fromCharCode(...b.slice(0, 6)) === 'GIF87a' || String.fromCharCode(...b.slice(0, 6)) === 'GIF89a',
  webp: (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
};
const SPACES_REG = 'registry/spaces.json';
const REQUESTS_REG = 'registry/requests.json';
const DEMOS_REG = 'registry/demos.json';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Sent on every response. The API only returns JSON and images, so nothing may frame or run it.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const cors = corsHeaders(env, request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...SECURITY_HEADERS } });

    let res;
    try {
      res = await route(request, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      // 500s and storage errors can carry config or GitHub details: log them, and
      // show the client only a reference it can quote.
      const internal = status === 500 || status === 502;
      if (internal) console.error(JSON.stringify({ requestId, method: request.method, path: new URL(request.url).pathname, status, error: String(err?.message || err), stack: err?.stack }));
      res = json({ error: internal ? `Something went wrong on our side. Reference: ${requestId}` : err.message, requestId }, status);
      if (status === 429) res.headers.set('Retry-After', '60');
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries({ ...cors, ...SECURITY_HEADERS })) headers.set(k, v);
    headers.set('X-Request-Id', requestId);
    return new Response(res.body, { status: res.status, headers });
  },

  // Cron trigger (see wrangler.toml): delete expired demo spaces.
  async scheduled(event, env, ctx) {
    checkEnv(env);
    ctx.waitUntil(cleanupDemos(env).catch((err) => console.error('demo cleanup failed', err)));
  },
};

/* ------------------------------------------------------------------ routing */

async function route(request, env) {
  checkEnv(env);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method;

  if (parts[0] === 'img' && method === 'GET') {
    const [, id, ...rest] = parts;
    const { sp, idx } = await spaceFor(env, id);
    if (!(await validImageToken(env, idx, url.searchParams.get('t')))) throw new HttpError(401, 'Image link expired. Reload the page.');
    return serveImage(env, sp, rest.join('/'));
  }
  if (parts[0] !== 'api') throw new HttpError(404, 'Not found');
  const [, a, ...rest] = parts;
  if (method !== 'GET') await limitWrites(env, request);

  if (a === 'config' && method === 'GET') return json(publicConfig(env));
  if (a === 'demo' && method === 'POST') {
    await verifyTurnstile(env, request);
    return json(await createDemo(env, request), 201);
  }
  if (a === 'requests') return requestRoutes(request, env, rest, method);
  if (a === 'admin') {
    if (rest[0] === 'session' && rest.length === 1 && method === 'POST') return json(await adminSignIn(env, request), 201);
    if (!(await isSiteAdmin(request, env))) throw new HttpError(403, 'Site admin sign-in required');
    return adminRoutes(request, env, rest, method);
  }
  if (a === 's' && rest[0]) return spaceRoutes(request, env, rest[0], rest.slice(1), method);
  throw new HttpError(404, 'Not found');
}

async function spaceRoutes(request, env, id, p, method) {
  const ctx = await access(request, env, id);
  const { sp } = ctx;
  const [a, b, c, d, e] = p;

  if (a === 'me' && method === 'GET') {
    return json({
      admin: ctx.admin,
      siteAdmin: ctx.site,
      authorized: ctx.reviewer,
      space: ctx.reviewer ? publicSpace(ctx.idx) : { id, kind: ctx.idx.kind, expiresAt: ctx.idx.expiresAt || null },
      // Admins need the code to build share links.
      reviewCode: ctx.admin ? formatCode(await reviewCode(env, id, ctx.idx)) : null,
      imageToken: ctx.reviewer ? await imageToken(env, ctx.idx) : null,
    });
  }

  if (!ctx.reviewer) throw new HttpError(401, 'Review code required');
  const needAdmin = () => { if (!ctx.admin) throw new HttpError(403, 'Space key required'); };

  if (!a && method === 'DELETE') {
    // Demo owners can delete their demo early; approved spaces are deleted by the site admin.
    needAdmin();
    if (ctx.idx.kind !== 'demo' && !ctx.site) throw new HttpError(403, 'Ask the site admin to delete this space');
    await deleteSpace(env, id);
    return json({ ok: true });
  }

  if (a === 'project' && !b) {
    if (method === 'GET') return json(await loadProject(env, sp));
    if (method === 'PATCH') {
      needAdmin();
      const body = await readBody(request);
      const title = cleanText(body.title, 120, 'Title');
      await updateJson(env, sp.br, indexPath(sp), (idx) => ({ ...must(idx, 'Space'), title }), 'review: rename space');
      return json(await loadProject(env, sp));
    }
  }

  if (a === 'rotate-code' && !b && method === 'POST') {
    needAdmin();
    const idx = await updateJson(env, sp.br, indexPath(sp), (x) => {
      must(x, 'Space');
      x.codeVersion = (x.codeVersion || 1) + 1;
      x.codeScheme = CODE_SCHEME; // upgrades older spaces to the longer code
      return x;
    }, 'review: new review code');
    authCache.delete(id);
    return json({ reviewCode: formatCode(await reviewCode(env, id, idx)), imageToken: await imageToken(env, idx) });
  }

  if (a === 'sections') {
    if (!b && method === 'POST') { needAdmin(); return json(await createSection(env, sp, await readBody(request)), 201); }
    if (b && !ID_RE.test(b)) throw new HttpError(400, 'Bad section id');

    if (b && !c) {
      if (method === 'PATCH') { needAdmin(); return json(await updateSection(env, sp, b, await readBody(request))); }
      if (method === 'DELETE') { needAdmin(); await deleteSection(env, sp, b); return json({ ok: true }); }
    }
    if (b && c === 'images') {
      if (!d && method === 'POST') { needAdmin(); return json(await uploadImage(env, sp, b, await readBody(request, 22 * MB)), 201); }
      if (d && !e && method === 'PATCH') { needAdmin(); return json(await updateImage(env, sp, b, d, await readBody(request))); }
      if (d && !e && method === 'DELETE') { needAdmin(); return json(await deleteImage(env, sp, b, d)); }
    }
    if (b && c === 'comments') {
      if (!d && method === 'POST') return json(await addComment(env, sp, b, await readBody(request)), 201);
      if (d && !e && method === 'PATCH') { needAdmin(); return json(await updateComment(env, sp, b, d, await readBody(request))); }
      if (d && !e && method === 'DELETE') { needAdmin(); return json(await deleteComment(env, sp, b, d)); }
    }
  }
  throw new HttpError(404, 'Not found');
}

async function requestRoutes(request, env, p, method) {
  const [id, action] = p;
  if (!id && method === 'POST') {
    await verifyTurnstile(env, request);
    return json(await createRequest(env, request), 201);
  }
  if (id && action === 'status' && method === 'POST') return json(await requestStatus(env, id, await readBody(request)));
  throw new HttpError(404, 'Not found');
}

async function adminRoutes(request, env, p, method) {
  const [a, id, action] = p;
  if (a === 'overview' && !id && method === 'GET') return json(await adminOverview(env));
  if (a === 'cleanup' && !id && method === 'POST') return json(await cleanupDemos(env));

  if (a === 'requests' && id) {
    if (action === 'approve' && method === 'POST') return json(await approveRequest(env, id, await readBody(request)), 201);
    if (action === 'reject' && method === 'POST') return json(await rejectRequest(env, id, await readBody(request)));
    if (!action && method === 'DELETE') return json(await deleteRequest(env, id));
  }

  if (a === 'spaces') {
    if (!id && method === 'POST') return json(await adminCreateSpace(env, await readBody(request)), 201);
    if (id && !SPACE_RE.test(id)) throw new HttpError(400, 'Bad space id');
    if (id && !action) {
      if (method === 'GET') return json(await adminSpaceInfo(env, id));
      if (method === 'PATCH') return json(await adminUpdateSpace(env, id, await readBody(request)));
      if (method === 'DELETE') { await deleteSpace(env, id); return json({ ok: true }); }
    }
    if (id && action === 'keys' && method === 'GET') {
      const idx = must(await readJson(env, branchFor(env, id), `spaces/${id}/index.json`), 'Space');
      return json(await keysFor(env, idx));
    }
    if (id && action === 'rotate-key' && method === 'POST') {
      const sp = space(env, id);
      const idx = await updateJson(env, sp.br, indexPath(sp), (x) => {
        must(x, 'Space');
        x.keyVersion = (x.keyVersion || 1) + 1;
        return x;
      }, 'admin: new space key');
      authCache.delete(id);
      return json(await keysFor(env, idx));
    }
  }
  throw new HttpError(404, 'Not found');
}

/* ------------------------------------------------------------------- access */

const dataBranch = (env) => env.GITHUB_BRANCH || 'review-data';
const demoBranch = (env) => env.DEMO_BRANCH || 'demo-data';
const isDemoId = (id) => id[0] === 'd';
const branchFor = (env, id) => (isDemoId(id) ? demoBranch(env) : dataBranch(env));
const space = (env, id) => ({ id, br: branchFor(env, id), base: `spaces/${id}` });
const indexPath = (sp) => `${sp.base}/index.json`;
const sectionPath = (sp, sid) => `${sp.base}/sections/${sid}.json`;
const imagePath = (sp, rel) => `${sp.base}/images/${rel}`;

// Space ids start with a base-36 timestamp, so a demo's age is known without a read.
const newSpaceId = (prefix) => prefix + newId();
const idTime = (id) => parseInt(id.slice(1, -6), 36);

function settings(env) {
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    demoEnabled: env.DEMO_ENABLED !== 'false',
    demoQuota: Math.round(num(env.DEMO_QUOTA_MB, 5) * MB),
    demoHours: num(env.DEMO_HOURS, 24),
    demoMaxActive: num(env.DEMO_MAX_ACTIVE, 30),
    demoPerIp: num(env.DEMO_PER_IP_PER_DAY, 3),
    spaceQuota: Math.round(num(env.SPACE_QUOTA_MB, 200) * MB),
    maxPending: num(env.MAX_PENDING_REQUESTS, 50),
  };
}

function publicConfig(env) {
  const s = settings(env);
  return {
    demo: { enabled: s.demoEnabled, quotaBytes: s.demoQuota, hours: s.demoHours },
    spaceQuotaBytes: s.spaceQuota,
    turnstileSiteKey: env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null,
    adminOtp: !!env.ADMIN_TOTP_SECRET,
  };
}

// Space settings used for auth, cached briefly per isolate to save a GitHub read
// on every request. A rotated key or code stops working everywhere within 30 s.
const authCache = new Map();
async function spaceForAuth(env, id) {
  const hit = authCache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.idx;
  const idx = await readJson(env, branchFor(env, id), `spaces/${id}/index.json`);
  if (idx) authCache.set(id, { at: Date.now(), idx }); else authCache.delete(id);
  return idx;
}

async function spaceFor(env, id) {
  if (!SPACE_RE.test(String(id || ''))) throw new HttpError(404, 'Space not found');
  if (isDemoId(id) && Date.now() - idTime(id) > settings(env).demoHours * 3600e3) {
    throw new HttpError(410, 'This demo space has expired and its files have been deleted.');
  }
  const idx = await spaceForAuth(env, id);
  if (!idx) throw new HttpError(404, 'Space not found');
  return { sp: space(env, id), idx };
}

async function access(request, env, id) {
  const { sp, idx } = await spaceFor(env, id);
  const site = await isSiteAdmin(request, env);
  const key = request.headers.get('X-Space-Key');
  const admin = site || (!!key && await checkCredential(env, request, `${id}:k`, key, () => spaceKey(env, id, idx.keyVersion)));
  const code = normCode(request.headers.get('X-Review-Code'));
  const reviewer = admin || (!!code && await checkCredential(env, request, `${id}:c`, code, () => reviewCode(env, id, idx)));
  return { sp, idx, site, admin, reviewer };
}

/**
 * Compares a presented credential with the real one. A credential this isolate
 * has already seen succeed is free; any other attempt costs one AUTH_LIMIT unit
 * before it is checked, so once an IP runs out every guess is refused, right or
 * wrong, and guessing can't go faster than the limit.
 */
const goodCredentials = new Map(); // `${scope}:${credential}` -> expiry; in memory only
async function checkCredential(env, request, scope, given, expected) {
  const cacheKey = `${scope}:${given}`;
  const want = await expected();
  if ((goodCredentials.get(cacheKey) || 0) > Date.now()) return safeEqual(given, want);
  if (!(await allow(env, 'AUTH_LIMIT', await ipHash(env, request), env.RATE_AUTH_PER_MIN, 20))) {
    throw new HttpError(429, 'Too many attempts. Please wait a minute and try again.');
  }
  const ok = safeEqual(given, want);
  if (ok) {
    if (goodCredentials.size > 5000) goodCredentials.clear();
    goodCredentials.set(cacheKey, Date.now() + 10 * 60e3);
  }
  return ok;
}

/* ------------------------------------------------------------- abuse control */

/**
 * One unit from a per-IP limiter. Uses the Workers rate-limit binding `name` when
 * it is configured (see wrangler.toml), otherwise a fixed one-minute window kept
 * in this isolate's memory (dev, tests, or a plan without the binding).
 */
const memoryLimits = new WeakMap(); // env -> Map(key -> { start, n })
async function allow(env, name, key, perMin, fallback) {
  if (env[name]?.limit) return (await env[name].limit({ key })).success;
  if (!memoryLimits.has(env)) memoryLimits.set(env, new Map());
  const m = memoryLimits.get(env);
  const t = Date.now();
  const k = `${name}:${key}`;
  let w = m.get(k);
  if (!w || t - w.start >= 60_000) { w = { start: t, n: 0 }; m.set(k, w); }
  if (m.size > 10_000) for (const [mk, mw] of m) if (t - mw.start >= 60_000) m.delete(mk);
  return ++w.n <= (Number(perMin) > 0 ? Number(perMin) : fallback);
}

// Every write is at least one GitHub commit, and the token's hourly budget is
// shared by every space, so one visitor must not be able to spend it all.
async function limitWrites(env, request) {
  if (!(await allow(env, 'WRITE_LIMIT', await ipHash(env, request), env.RATE_WRITES_PER_MIN, 30))) {
    throw new HttpError(429, 'You’re saving very quickly. Please wait a minute and try again.');
  }
}

/** When TURNSTILE_SECRET is set, demo and request creation need a solved challenge. */
async function verifyTurnstile(env, request) {
  if (!env.TURNSTILE_SECRET) return;
  const token = request.headers.get('X-Turnstile-Token');
  if (!token || token.length > 2048) throw new HttpError(403, 'Please complete the “are you human” check and try again.');
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  let out;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    out = await res.json();
  } catch (err) {
    throw new HttpError(502, `Turnstile verification failed: ${err.message}`);
  }
  if (!out?.success) throw new HttpError(403, 'The “are you human” check failed. Please try again.');
}

/* -------------------------------------------------------------- credentials */

const enc = new TextEncoder();
async function hmacRaw(keyBytes, msg, hash = 'SHA-256') {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof msg === 'string' ? enc.encode(msg) : msg));
}
// Space keys and review codes: HMAC directly under SPACE_SECRET. Kept as is so
// existing keys and codes keep working.
const hmac = (env, msg) => hmacRaw(enc.encode(env.SPACE_SECRET), msg);

// Everything newer gets its own key, derived from SPACE_SECRET with HKDF, so one
// purpose can never produce a value that is valid for another.
const subkeys = new Map(); // `${secret}|${purpose}` -> bytes, per isolate
async function subkey(env, purpose) {
  const id = `${env.SPACE_SECRET}|${purpose}`;
  if (!subkeys.has(id)) {
    const base = await crypto.subtle.importKey('raw', enc.encode(env.SPACE_SECRET), 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('review-desk/v1'), info: enc.encode(purpose) }, base, 256);
    if (subkeys.size > 32) subkeys.clear();
    subkeys.set(id, new Uint8Array(bits));
  }
  return subkeys.get(id);
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function spaceKey(env, id, version = 1) {
  return `sk-${id}-${b64url(await hmac(env, `key:${id}:${version}`)).slice(0, 22)}`;
}
async function reviewCode(env, id, idx) {
  const version = idx.codeVersion || 1;
  if ((idx.codeScheme || 1) < 2) {
    // Scheme 1 (older spaces): 8 characters, slightly biased. Replaced on rotation.
    const bytes = await hmac(env, `code:${id}:${version}`);
    let out = '';
    for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
  }
  // Scheme 2: 12 characters, rejection-sampled so every character is equally likely.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  for (let round = 0; out.length < 12; round++) {
    for (const b of await hmac(env, `code2:${id}:${version}:${round}`)) {
      if (b < limit) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === 12) break;
    }
  }
  return out;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
const formatCode = (c) => c.match(/.{1,4}/g).join('-');

async function keysFor(env, idx) {
  return {
    spaceId: idx.id,
    adminKey: await spaceKey(env, idx.id, idx.keyVersion),
    reviewCode: formatCode(await reviewCode(env, idx.id, idx)),
  };
}

/**
 * Image URLs carry a token instead of the review code: `<exp>.<mac>`, bound to
 * the space and its current code version, so a new review code also cuts off
 * old image links. The expiry is rounded up to a 12-hour step, which keeps the
 * URL (and the browser cache) stable for at least 12 hours.
 */
async function imageToken(env, idx, t = Date.now()) {
  const exp = (Math.floor(t / IMAGE_TOKEN_STEP_MS) + 2) * IMAGE_TOKEN_STEP_MS;
  return `${exp.toString(36)}.${await imageMac(env, idx, exp)}`;
}
const imageMac = async (env, idx, exp) =>
  b64url(await hmacRaw(await subkey(env, 'image-token'), `img:${idx.id}:${idx.codeVersion || 1}:${exp}`)).slice(0, 32);
async function validImageToken(env, idx, token) {
  const m = String(token || '').match(/^([a-z0-9]{1,12})\.([A-Za-z0-9_-]{32})$/);
  if (!m) return false;
  const exp = parseInt(m[1], 36);
  if (!(exp > Date.now()) || exp - Date.now() > 2 * IMAGE_TOKEN_STEP_MS) return false;
  return safeEqual(m[2], await imageMac(env, idx, exp));
}

/* ------------------------------------------------------------ site admin auth */

/**
 * The admin key is sent once, to POST /api/admin/session, and exchanged for a
 * signed session that expires after an hour. Every attempt costs an AUTH_LIMIT
 * unit, right or wrong. With ADMIN_TOTP_SECRET set, an authenticator code is
 * required too.
 */
async function adminSignIn(env, request) {
  if (!(await allow(env, 'AUTH_LIMIT', await ipHash(env, request), env.RATE_AUTH_PER_MIN, 20))) {
    throw new HttpError(429, 'Too many attempts. Please wait a minute and try again.');
  }
  const body = await readBody(request);
  const keyOk = safeEqual(String(body.key || ''), env.ADMIN_KEY);
  const otpOk = !env.ADMIN_TOTP_SECRET || (await validTotp(env.ADMIN_TOTP_SECRET, String(body.otp || '')));
  if (!keyOk || !otpOk) {
    console.warn(JSON.stringify({ event: 'admin_sign_in_failed', ip: await ipHash(env, request), at: now() }));
    throw new HttpError(403, env.ADMIN_TOTP_SECRET ? 'That key or authenticator code is not correct.' : 'That key is not correct.');
  }
  console.log(JSON.stringify({ event: 'admin_sign_in', ip: await ipHash(env, request), at: now() }));
  const exp = Date.now() + ADMIN_SESSION_MS;
  return { session: `as.${exp.toString(36)}.${await adminMac(env, exp)}`, expiresAt: new Date(exp).toISOString() };
}

// Bound to ADMIN_KEY too, so changing the key signs every admin out.
const adminMac = async (env, exp) =>
  b64url(await hmacRaw(await subkey(env, 'admin-session'), `admin:${exp}:${await sha256hex(env.ADMIN_KEY)}`)).slice(0, 32);

async function isSiteAdmin(request, env) {
  const m = String(request.headers.get('X-Admin-Session') || '').match(/^as\.([a-z0-9]{1,12})\.([A-Za-z0-9_-]{32})$/);
  if (!m) return false;
  const exp = parseInt(m[1], 36);
  if (!(exp > Date.now()) || exp - Date.now() > ADMIN_SESSION_MS) return false;
  return safeEqual(m[2], await adminMac(env, exp));
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), accepting one step of clock drift either way. */
async function validTotp(secretB32, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 30_000);
  let ok = false;
  for (const s of [step - 1, step, step + 1]) {
    const msg = new Uint8Array(8);
    new DataView(msg.buffer).setBigUint64(0, BigInt(s));
    const h = await hmacRaw(key, msg, 'SHA-1');
    const o = h[h.length - 1] & 0xf;
    const n = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6;
    ok = safeEqual(String(n).padStart(6, '0'), code) || ok; // check every step: no timing hint
  }
  return ok;
}
function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out = [];
  let bits = 0, val = 0;
  for (const ch of clean) {
    val = (val << 5) | alpha.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
// Keyed, truncated hash: enough to rate-limit, not enough to recover the address.
const ipHash = async (env, request) =>
  b64url(await hmacRaw(await subkey(env, 'ip-hash'), `ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`)).slice(0, 16);
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(24)));

/* ------------------------------------------------------------------- spaces */

function publicSpace(idx) {
  return {
    id: idx.id, kind: idx.kind, title: idx.title,
    quotaBytes: idx.quotaBytes, usedBytes: idx.usedBytes || 0,
    createdAt: idx.createdAt, expiresAt: idx.expiresAt || null,
  };
}

async function createSpace(env, id, { kind, title, quotaBytes, expiresAt }) {
  const sp = space(env, id);
  const idx = {
    id, kind, title, sections: [], quotaBytes, usedBytes: 0,
    keyVersion: 1, codeVersion: 1, codeScheme: CODE_SCHEME, createdAt: now(), ...(expiresAt ? { expiresAt } : {}),
  };
  await putFile(env, sp.br, indexPath(sp), b64encodeUtf8(pretty(idx)), `${kind === 'demo' ? 'demo' : 'admin'}: create space "${forCommit(title)}"`);
  return { space: publicSpace(idx), ...(await keysFor(env, idx)) };
}

async function createDemo(env, request) {
  const s = settings(env);
  if (!s.demoEnabled) throw new HttpError(403, 'Demo spaces are turned off. Please request a space instead.');
  await ensureDemoBranch(env);
  const who = await ipHash(env, request);
  const t = Date.now();
  let id;
  await updateJson(env, demoBranch(env), DEMOS_REG, (reg) => {
    reg = reg || { demos: [] };
    const active = reg.demos.filter((d) => t - Date.parse(d.createdAt) < s.demoHours * 3600e3);
    if (active.length >= s.demoMaxActive) {
      throw new HttpError(429, 'All demo spaces are in use right now. Please try again later, or request your own space.');
    }
    const mine = reg.demos.filter((d) => d.ipHash === who && t - Date.parse(d.createdAt) < 86400e3);
    if (mine.length >= s.demoPerIp) {
      throw new HttpError(429, `You can start ${s.demoPerIp} demo spaces a day. Request a space to keep using Review Desk.`);
    }
    id = newSpaceId('d');
    reg.demos.push({ id, ipHash: who, createdAt: new Date(idTime(id)).toISOString() });
    return reg;
  }, 'demo: start demo', true);

  return createSpace(env, id, {
    kind: 'demo', title: 'Demo space', quotaBytes: s.demoQuota,
    expiresAt: new Date(idTime(id) + s.demoHours * 3600e3).toISOString(),
  });
}

async function deleteSpace(env, id) {
  const sp = space(env, id);
  const prefix = `${sp.base}/`;
  await rewriteBranch(env, sp.br, (blobs) => {
    const drop = blobs.filter((b) => b.path.startsWith(prefix)).map((b) => b.path);
    return drop.length ? { drop } : null;
  }, { message: `admin: delete space ${id}` });
  if (!isDemoId(id)) {
    await updateJson(env, sp.br, SPACES_REG, (reg) => {
      reg = reg || { spaces: [] };
      reg.spaces = reg.spaces.filter((x) => x.id !== id);
      return reg;
    }, 'admin: unlist space', true);
  }
  authCache.delete(id);
}

/**
 * Delete demo spaces older than DEMO_HOURS and forget demo starts older than a
 * day. The demo branch is rewritten as a single commit with no parent, so the
 * deleted screenshots are no longer reachable in git either.
 */
async function cleanupDemos(env) {
  const s = settings(env);
  const br = demoBranch(env);
  const ref = await gh(env, `/git/ref/heads/${encodePath(br)}`);
  if (ref.status === 404) return { removedSpaces: 0 };
  let removed = [];
  await rewriteBranch(env, br, async (blobs) => {
    const t = Date.now();
    const expired = new Set();
    for (const b of blobs) {
      const m = b.path.match(/^spaces\/([a-z0-9]+)\//);
      if (m && t - idTime(m[1]) > s.demoHours * 3600e3) expired.add(m[1]);
    }
    const regBlob = blobs.find((b) => b.path === DEMOS_REG);
    const reg = regBlob ? JSON.parse(await readBlob(env, regBlob.sha)) : { demos: [] };
    const keepFor = Math.max(s.demoHours * 3600e3, 86400e3);
    const demos = reg.demos.filter((d) => t - Date.parse(d.createdAt) < keepFor);
    removed = [...expired];
    if (!expired.size && demos.length === reg.demos.length) return null;
    return {
      drop: blobs.filter((b) => [...expired].some((id) => b.path.startsWith(`spaces/${id}/`))).map((b) => b.path),
      write: { [DEMOS_REG]: pretty({ demos }) },
    };
  }, { message: 'demo: remove expired demo spaces', orphan: true });
  for (const id of removed) authCache.delete(id);
  return { removedSpaces: removed.length };
}

/* ----------------------------------------------------------------- requests */

async function createRequest(env, request) {
  const s = settings(env);
  const body = await readBody(request);
  const name = cleanText(body.name, 80, 'Name');
  const email = cleanText(body.email, 200, 'Email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Please enter a valid email address');
  const organization = cleanText(body.organization || '', 120, 'Organization', true);
  const purpose = cleanText(body.purpose, 1000, 'Purpose', false, true);
  const who = await ipHash(env, request);
  const token = randomToken();
  const tokenHash = await sha256hex(token);
  const id = newId();

  await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
    reg = reg || { requests: [] };
    const pending = reg.requests.filter((r) => r.status === 'pending');
    if (pending.length >= s.maxPending) throw new HttpError(429, 'We have a lot of requests waiting. Please try again in a few days.');
    if (pending.filter((r) => r.ipHash === who).length >= 3) throw new HttpError(429, 'You already have requests waiting for review.');
    reg.requests.push({ id, name, email, organization, purpose, status: 'pending', createdAt: now(), ipHash: who, tokenHash });
    return reg;
  }, 'requests: new space request', true);
  return { id, token, status: 'pending' };
}

async function findRequest(env, id) {
  const reg = await readJson(env, dataBranch(env), REQUESTS_REG);
  return reg?.requests.find((r) => r.id === id) || null;
}

/** Requester's view. Keys of an approved space are handed out once, then hidden. */
async function requestStatus(env, id, body) {
  const r = await findRequest(env, id);
  if (!r || !r.tokenHash || !safeEqual(await sha256hex(String(body.token || '')), r.tokenHash)) {
    throw new HttpError(404, 'Request not found');
  }
  const out = {
    id, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt || null,
    reason: r.reason || '', spaceId: r.spaceId || null, claimed: !!r.claimedAt,
  };
  if (r.status === 'approved' && !r.claimedAt) {
    const idx = await readJson(env, dataBranch(env), `spaces/${r.spaceId}/index.json`);
    if (idx) {
      Object.assign(out, await keysFor(env, idx), { title: idx.title });
      await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
        const x = reg.requests.find((q) => q.id === id);
        if (x) x.claimedAt = now();
        return reg;
      }, 'requests: keys collected');
    }
  }
  return out;
}

const quotaFrom = (mb, fallback) => {
  if (mb === undefined || mb === '' || mb === null) return fallback;
  const n = Number(mb);
  if (!(n >= 1 && n <= 10240)) throw new HttpError(400, 'Storage must be between 1 and 10240 MB');
  return Math.round(n * MB);
};

async function approveRequest(env, id, body) {
  const s = settings(env);
  const quotaBytes = quotaFrom(body.quotaMb, s.spaceQuota);
  const spaceId = newSpaceId('s');
  let req;
  // Claim the request first, so approving twice can't create two spaces.
  await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
    req = must(reg?.requests.find((r) => r.id === id), 'Request');
    if (req.status !== 'pending') throw new HttpError(409, `This request was already ${req.status}`);
    Object.assign(req, { status: 'approved', spaceId, decidedAt: now() });
    return reg;
  }, 'requests: approve');

  const title = cleanText(body.title || req.organization || `${req.name}'s space`, 120, 'Title');
  let created;
  try {
    created = await createSpace(env, spaceId, { kind: 'space', title, quotaBytes });
  } catch (err) {
    await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
      const r = reg.requests.find((x) => x.id === id);
      if (r) Object.assign(r, { status: 'pending', spaceId: null, decidedAt: null });
      return reg;
    }, 'requests: undo approve').catch(() => {});
    throw err;
  }
  await registerSpace(env, { id: spaceId, title, owner: req.name, email: req.email, requestId: id });
  return created;
}

async function rejectRequest(env, id, body) {
  const reason = cleanText(body.reason || '', 500, 'Reason', true, true);
  await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
    const r = must(reg?.requests.find((x) => x.id === id), 'Request');
    if (r.status !== 'pending') throw new HttpError(409, `This request was already ${r.status}`);
    Object.assign(r, { status: 'rejected', reason, decidedAt: now() });
    return reg;
  }, 'requests: reject');
  return { ok: true };
}

async function deleteRequest(env, id) {
  await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
    must(reg?.requests.find((x) => x.id === id), 'Request');
    reg.requests = reg.requests.filter((x) => x.id !== id);
    return reg;
  }, 'requests: delete request');
  return { ok: true };
}

/* -------------------------------------------------------------- site admin */

async function registerSpace(env, entry) {
  await updateJson(env, dataBranch(env), SPACES_REG, (reg) => {
    reg = reg || { spaces: [] };
    reg.spaces.push({ ...entry, createdAt: now() });
    return reg;
  }, 'admin: list space', true);
}

async function adminCreateSpace(env, body) {
  const title = cleanText(body.title, 120, 'Title');
  const owner = cleanText(body.owner || '', 80, 'Owner', true);
  const email = cleanText(body.email || '', 200, 'Email', true);
  const quotaBytes = quotaFrom(body.quotaMb, settings(env).spaceQuota);
  const id = newSpaceId('s');
  const created = await createSpace(env, id, { kind: 'space', title, quotaBytes });
  await registerSpace(env, { id, title, owner, email, requestId: null });
  return created;
}

async function adminOverview(env) {
  const [reqs, spaces, demos] = await Promise.all([
    readJson(env, dataBranch(env), REQUESTS_REG),
    readJson(env, dataBranch(env), SPACES_REG),
    readJson(env, demoBranch(env), DEMOS_REG),
  ]);
  const s = settings(env);
  const t = Date.now();
  return {
    requests: (reqs?.requests || [])
      .map(({ ipHash: _ip, tokenHash: _t, ...r }) => r)
      .sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || b.createdAt.localeCompare(a.createdAt)),
    spaces: (spaces?.spaces || []).slice().reverse(),
    demos: (demos?.demos || [])
      .filter((d) => t - idTime(d.id) < s.demoHours * 3600e3)
      .map((d) => ({ id: d.id, createdAt: d.createdAt, expiresAt: new Date(idTime(d.id) + s.demoHours * 3600e3).toISOString() }))
      .reverse(),
    settings: publicConfig(env),
  };
}

async function adminSpaceInfo(env, id) {
  const idx = must(await readJson(env, branchFor(env, id), `spaces/${id}/index.json`), 'Space');
  return { ...publicSpace(idx), sections: idx.sections.length };
}

async function adminUpdateSpace(env, id, body) {
  const sp = space(env, id);
  const idx = await updateJson(env, sp.br, indexPath(sp), (x) => {
    must(x, 'Space');
    if (body.quotaMb !== undefined) x.quotaBytes = quotaFrom(body.quotaMb, x.quotaBytes);
    if (body.title !== undefined) x.title = cleanText(body.title, 120, 'Title');
    return x;
  }, 'admin: update space');
  return { ...publicSpace(idx), sections: idx.sections.length };
}

/* ----------------------------------------------------------------- handlers */

async function loadProject(env, sp) {
  const idx = must(await readJson(env, sp.br, indexPath(sp)), 'Space');
  const sections = await Promise.all(idx.sections.map((sid) => readJson(env, sp.br, sectionPath(sp, sid))));
  return { title: idx.title, space: publicSpace(idx), sections: sections.filter(Boolean) };
}

async function createSection(env, sp, body) {
  const section = {
    id: newId(),
    title: cleanText(body.title, 120, 'Title'),
    description: cleanText(body.description || '', 1000, 'Description', true, true),
    createdAt: now(),
    images: [],
    comments: [],
  };
  await updateJson(env, sp.br, indexPath(sp), (idx) => {
    must(idx, 'Space');
    if (idx.sections.length >= MAX_SECTIONS) throw new HttpError(400, `A space can have up to ${MAX_SECTIONS} sections`);
    idx.sections.push(section.id);
    return idx;
  }, `review: list section "${forCommit(section.title)}"`);
  await putFile(env, sp.br, sectionPath(sp, section.id), b64encodeUtf8(pretty(section)), `review: add section "${forCommit(section.title)}"`);
  return section;
}

async function updateSection(env, sp, id, body) {
  return updateJson(env, sp.br, sectionPath(sp, id), (s) => {
    must(s, 'Section');
    if (body.title !== undefined) s.title = cleanText(body.title, 120, 'Title');
    if (body.description !== undefined) s.description = cleanText(body.description, 1000, 'Description', true, true);
    return s;
  }, 'review: edit section');
}

const sumBytes = (section) => section.images.reduce((n, i) => n + (i.bytes || 0), 0);

async function deleteSection(env, sp, sid) {
  const section = await readJson(env, sp.br, sectionPath(sp, sid));
  await updateJson(env, sp.br, indexPath(sp), (idx) => {
    must(idx, 'Space');
    idx.sections = idx.sections.filter((s) => s !== sid);
    if (section) idx.usedBytes = Math.max(0, (idx.usedBytes || 0) - sumBytes(section));
    return idx;
  }, `review: delete section "${forCommit(section?.title || sid)}"`);
  // One commit for the section file and all its screenshots.
  const file = sectionPath(sp, sid);
  const dir = `${sp.base}/images/${sid}/`;
  await rewriteBranch(env, sp.br, (blobs) => {
    const drop = blobs.filter((b) => b.path === file || b.path.startsWith(dir)).map((b) => b.path);
    return drop.length ? { drop } : null;
  }, { message: `review: delete files of section "${forCommit(section?.title || sid)}"` });
}

/** Adds `delta` bytes to the space's usage, refusing to go over its quota. */
async function reserve(env, sp, delta) {
  await updateJson(env, sp.br, indexPath(sp), (idx) => {
    must(idx, 'Space');
    const used = idx.usedBytes || 0;
    if (delta > 0 && used + delta > idx.quotaBytes) {
      throw new HttpError(413, `Not enough storage: this image is ${fmtMB(delta)} and ${fmtMB(Math.max(0, idx.quotaBytes - used))} of ${fmtMB(idx.quotaBytes)} is left.`);
    }
    idx.usedBytes = Math.max(0, used + delta);
    return idx;
  }, delta > 0 ? 'review: reserve storage' : 'review: free storage');
}

async function uploadImage(env, sp, sectionId, body) {
  const filename = cleanText(body.filename || 'screenshot.png', 200, 'File name');
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (!IMAGE_TYPES[ext]) throw new HttpError(400, 'Only PNG, JPG, GIF and WebP images are supported');
  const data = String(body.data || '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, 'Image data missing or not base64');
  const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) throw new HttpError(413, 'Image is larger than 15 MB');
  // The extension is only a claim: check the file really starts like that format.
  const head = Uint8Array.from(atob(data.slice(0, 16)), (c) => c.charCodeAt(0));
  if (!IMAGE_MAGIC[ext === 'jpeg' ? 'jpg' : ext](head)) throw new HttpError(400, `This file isn’t a valid ${ext.toUpperCase()} image`);

  const section = must(await readJson(env, sp.br, sectionPath(sp, sectionId)), 'Section');
  if (section.images.length >= MAX_IMAGES_PER_SECTION) throw new HttpError(400, `A section can have up to ${MAX_IMAGES_PER_SECTION} screenshots`);

  await reserve(env, sp, bytes);
  const id = newId();
  const slug = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'screenshot';
  const rel = `${sectionId}/${id}-${slug}.${ext === 'jpeg' ? 'jpg' : ext}`;
  try {
    await putFile(env, sp.br, imagePath(sp, rel), data, `review: upload ${rel.split('/').pop()} to "${forCommit(section.title)}"`);
  } catch (err) {
    await reserve(env, sp, -bytes).catch(() => {});
    throw err;
  }
  try {
    return await updateJson(env, sp.br, sectionPath(sp, sectionId), (s) => {
      must(s, 'Section');
      s.images.push({
        id, path: rel, bytes,
        name: filename,
        caption: cleanText(body.caption || '', 200, 'Caption', true, true),
        uploadedAt: now(),
      });
      return s;
    }, `review: add screenshot to "${forCommit(section.title)}"`);
  } catch (err) {
    await deleteFileIfExists(env, sp.br, imagePath(sp, rel), 'review: undo upload').catch(() => {});
    await reserve(env, sp, -bytes).catch(() => {});
    throw err;
  }
}

async function updateImage(env, sp, sectionId, imageId, body) {
  return updateJson(env, sp.br, sectionPath(sp, sectionId), (s) => {
    must(s, 'Section');
    const img = must(s.images.find((i) => i.id === imageId), 'Screenshot');
    if (body.caption !== undefined) img.caption = cleanText(body.caption, 200, 'Caption', true, true);
    return s;
  }, 'review: edit caption');
}

async function deleteImage(env, sp, sectionId, imageId) {
  let removed;
  const section = await updateJson(env, sp.br, sectionPath(sp, sectionId), (s) => {
    must(s, 'Section');
    removed = must(s.images.find((i) => i.id === imageId), 'Screenshot');
    s.images = s.images.filter((i) => i.id !== imageId);
    s.comments = s.comments.filter((c) => c.target !== imageId);
    return s;
  }, 'review: remove screenshot');
  await deleteFileIfExists(env, sp.br, imagePath(sp, removed.path), `review: delete ${forCommit(removed.name)}`);
  if (removed.bytes) await reserve(env, sp, -removed.bytes);
  return section;
}

async function addComment(env, sp, sectionId, body) {
  const author = cleanText(body.author, MAX_NAME, 'Name');
  const text = cleanText(body.text, MAX_COMMENT, 'Comment', false, true);
  const parentId = body.parentId ? String(body.parentId) : null;

  return updateJson(env, sp.br, sectionPath(sp, sectionId), (s) => {
    must(s, 'Section');
    if (s.comments.length >= MAX_COMMENTS_PER_SECTION) throw new HttpError(400, 'This section has reached its comment limit');
    let target = String(body.target || 'section');
    let pin = null;

    if (parentId) {
      const parent = must(s.comments.find((c) => c.id === parentId && !c.parentId), 'Comment to reply to');
      target = parent.target;
    } else {
      if (target !== 'section' && !s.images.some((i) => i.id === target)) throw new HttpError(404, 'Screenshot not found');
      if (target !== 'section' && body.pin && isFinite(body.pin.x) && isFinite(body.pin.y)) {
        const clamp = (n) => Math.round(Math.min(100, Math.max(0, Number(n))) * 100) / 100;
        pin = { x: clamp(body.pin.x), y: clamp(body.pin.y) };
      }
    }
    s.comments.push({ id: newId(), target, parentId, author, text, pin, createdAt: now(), resolved: false });
    return s;
  }, `review: comment by ${forCommit(author)}`);
}

async function updateComment(env, sp, sectionId, commentId, body) {
  return updateJson(env, sp.br, sectionPath(sp, sectionId), (s) => {
    must(s, 'Section');
    const c = must(s.comments.find((x) => x.id === commentId), 'Comment');
    if (body.resolved !== undefined) {
      c.resolved = !!body.resolved;
      c.resolvedAt = c.resolved ? now() : null;
    }
    return s;
  }, 'review: update comment status');
}

async function deleteComment(env, sp, sectionId, commentId) {
  return updateJson(env, sp.br, sectionPath(sp, sectionId), (s) => {
    must(s, 'Section');
    must(s.comments.find((x) => x.id === commentId), 'Comment');
    s.comments = s.comments.filter((x) => x.id !== commentId && x.parentId !== commentId);
    return s;
  }, 'review: delete comment');
}

async function serveImage(env, sp, rel) {
  if (!IMAGE_REL_RE.test(rel)) throw new HttpError(400, 'Bad image path');
  const ext = rel.split('.').pop();
  const path = imagePath(sp, rel);
  const res = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(sp.br)}`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (res.status === 404) throw new HttpError(404, 'Image not found');
  if (!res.ok) throw new HttpError(502, `GitHub image read failed (${res.status})`);
  return new Response(res.body, {
    headers: {
      'Content-Type': IMAGE_TYPES[ext],
      // Image paths contain a unique id, so they never change.
      'Cache-Control': `private, max-age=${isDemoId(sp.id) ? 3600 : 31536000}, immutable`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/* ------------------------------------------------------------ GitHub layer */

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'review-desk-worker',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
}

async function ghJson(env, path, init = {}, op = 'read') {
  const res = await gh(env, path, init);
  if (!res.ok) {
    const err = new HttpError(502, githubHint(res.status, op));
    err.ghStatus = res.status;
    throw err;
  }
  return res.json();
}

/** Returns { sha, text } for a small text file, or null if it doesn't exist. */
async function getTextFile(env, br, path) {
  const res = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(br)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, githubHint(res.status, 'read'));
  const meta = await res.json();
  if (meta.encoding === 'base64' && meta.content) {
    return { sha: meta.sha, text: b64decodeUtf8(meta.content.replace(/\n/g, '')) };
  }
  // Files over 1 MB come back without inline content.
  const raw = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(br)}`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (!raw.ok) throw new HttpError(502, githubHint(raw.status, 'read'));
  return { sha: meta.sha, text: await raw.text() };
}

async function readJson(env, br, path) {
  const f = await getTextFile(env, br, path);
  return f ? JSON.parse(f.text) : null;
}

async function readBlob(env, sha) {
  const blob = await ghJson(env, `/git/blobs/${sha}`);
  return b64decodeUtf8(String(blob.content).replace(/\n/g, ''));
}

async function putFile(env, br, path, base64, message, sha) {
  const res = await gh(env, `/contents/${encodePath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64, branch: br, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    const err = new HttpError(502, githubHint(res.status, 'write'));
    err.ghStatus = res.status;
    throw err;
  }
  return res.json();
}

async function deleteFileIfExists(env, br, path, message) {
  const res = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(br)}`);
  if (res.status === 404) return;
  if (!res.ok) throw new HttpError(502, githubHint(res.status, 'read'));
  const { sha } = await res.json();
  const del = await gh(env, `/contents/${encodePath(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: br }),
  });
  if (!del.ok && del.status !== 404) throw new HttpError(502, githubHint(del.status, 'delete'));
}

/**
 * Read-modify-write a JSON file with optimistic locking. Several people may
 * comment at once; GitHub rejects a write with a stale sha (409/422), so we
 * re-read and re-apply the change.
 */
async function updateJson(env, br, path, mutate, message, allowCreate = false) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const file = await getTextFile(env, br, path);
    if (!file && !allowCreate) throw new HttpError(404, 'Not found');
    const current = file ? JSON.parse(file.text) : null;
    const next = mutate(current);
    try {
      await putFile(env, br, path, b64encodeUtf8(pretty(next)), message, file?.sha);
      return next;
    } catch (err) {
      if (err.ghStatus === 409 || err.ghStatus === 422) {
        await sleep(150 + Math.random() * 350 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(503, 'Too many people saving at once — please try again');
}

/**
 * Replace a branch's whole tree in one commit. `plan(blobs)` returns the paths
 * to drop and files to write, or null for no change. Used where the Contents
 * API would need two calls per file, and for demo cleanup with `orphan`, which
 * also drops the branch history.
 */
async function rewriteBranch(env, br, plan, { message, orphan = false }) {
  const ref = `/git/ref/heads/${encodePath(br)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = (await ghJson(env, ref)).object.sha;
    const treeSha = (await ghJson(env, `/git/commits/${head}`)).tree.sha;
    const tree = await ghJson(env, `/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated) throw new HttpError(500, 'The data branch has too many files to rewrite at once');
    const blobs = tree.tree.filter((e) => e.type === 'blob');
    const change = await plan(blobs);
    if (!change) return false;

    const drop = new Set(change.drop || []);
    const write = change.write || {};
    const entries = blobs
      .filter((b) => !drop.has(b.path) && !(b.path in write))
      .map((b) => ({ path: b.path, mode: b.mode, type: 'blob', sha: b.sha }));
    for (const [path, content] of Object.entries(write)) entries.push({ path, mode: '100644', type: 'blob', content });
    if (!entries.length) entries.push({ path: '.keep', mode: '100644', type: 'blob', content: '' });

    const newTree = (await ghJson(env, '/git/trees', { method: 'POST', body: JSON.stringify({ tree: entries }) }, 'write')).sha;
    const commit = (await ghJson(env, '/git/commits', {
      method: 'POST', body: JSON.stringify({ message, tree: newTree, parents: orphan ? [] : [head] }),
    }, 'write')).sha;
    // A force update can't detect a write that landed meanwhile, so check right before it.
    if (orphan && (await ghJson(env, ref)).object.sha !== head) continue;
    const res = await gh(env, `/git/refs/heads/${encodePath(br)}`, {
      method: 'PATCH', body: JSON.stringify({ sha: commit, force: orphan }),
    });
    if (res.ok) return true;
    if (res.status === 409 || res.status === 422) { await sleep(200 + Math.random() * 400); continue; }
    throw new HttpError(502, githubHint(res.status, 'write'));
  }
  throw new HttpError(503, 'The data branch is busy — please try again');
}

// Creating the demo branch needs the Git Data API (an orphan commit), done once.
const knownBranches = new WeakMap();
async function ensureDemoBranch(env) {
  const br = demoBranch(env);
  if (knownBranches.get(env)?.has(br)) return;
  const res = await gh(env, `/git/ref/heads/${encodePath(br)}`);
  if (res.status === 404) {
    const tree = (await ghJson(env, '/git/trees', {
      method: 'POST',
      body: JSON.stringify({ tree: [{ path: DEMOS_REG, mode: '100644', type: 'blob', content: pretty({ demos: [] }) }] }),
    }, 'write')).sha;
    const commit = (await ghJson(env, '/git/commits', {
      method: 'POST', body: JSON.stringify({ message: 'demo: start demo branch', tree, parents: [] }),
    }, 'write')).sha;
    const mk = await gh(env, '/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${br}`, sha: commit }) });
    if (!mk.ok && mk.status !== 422) throw new HttpError(502, githubHint(mk.status, 'write'));
  } else if (!res.ok) {
    throw new HttpError(502, githubHint(res.status, 'read'));
  }
  if (!knownBranches.has(env)) knownBranches.set(env, new Set());
  knownBranches.get(env).add(br);
}

function githubHint(status, op) {
  if (status === 401) return 'GitHub rejected the token (401). Check GITHUB_TOKEN.';
  if (status === 403) return `GitHub refused the ${op} (403). The token needs Contents: read & write on this repo, or the rate limit was hit.`;
  if (status === 404) return `GitHub ${op} failed (404). Check GITHUB_OWNER, GITHUB_REPO and that the GITHUB_BRANCH branch exists.`;
  return `GitHub ${op} failed (${status})`;
}

/* ------------------------------------------------------------------ helpers */

function checkEnv(env) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'ADMIN_KEY', 'SPACE_SECRET'].filter((k) => !env[k]);
  if (missing.length) throw new HttpError(500, `Worker not configured: missing ${missing.join(', ')}`);
}

// Only origins listed in ALLOWED_ORIGINS get CORS headers; unset means no browser
// origin is allowed. '*' is for local development only.
function corsHeaders(env, origin) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : (origin && allowed.includes(origin) ? origin : null);
  if (!allow) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Session, X-Space-Key, X-Review-Code, X-Turnstile-Token',
    'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Reads a JSON body, counting bytes as they arrive (Content-Length can be absent or wrong). */
async function readBody(request, max = 64 * 1024) {
  if (Number(request.headers.get('Content-Length')) > max) throw new HttpError(413, 'Request is too large');
  if (!request.body) throw new HttpError(400, 'Body must be JSON');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'Request is too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'Body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
  return body;
}

/**
 * Trims and length-checks user text and removes control characters. Single-line
 * fields (names, titles, emails) also have line breaks and tabs turned into spaces.
 */
function cleanText(value, max, label, optional = false, multiline = false) {
  let s = String(value ?? '').replace(/\r\n?/g, '\n');
  s = multiline
    ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, '')
    : s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
  s = s.trim();
  if (!s && !optional) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
  return s;
}
// User text inside a git commit message: one short line, no quotes to break out of.
const forCommit = (s) => String(s).replace(/[\u0000-\u001f\u007f"`]+/g, ' ').slice(0, 60);

function must(value, label) {
  if (!value) throw new HttpError(404, `${label} not found`);
  return value;
}

const fmtMB = (b) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
const now = () => new Date().toISOString();
const pretty = (o) => JSON.stringify(o, null, 2) + '\n';
function newId() {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return Date.now().toString(36) + Array.from(rand, (b) => (b % 36).toString(36)).join('');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
