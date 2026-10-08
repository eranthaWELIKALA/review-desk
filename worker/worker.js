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
 * Accounts, memberships, invites and the audit log live in D1 (binding DB, see
 * migrations/). Sign-in is handled by Clerk: the site sends a short-lived Clerk
 * session token as `Authorization: Bearer …`, verified here (RS256, iss, azp).
 *
 * Who can do what:
 *   site admin   signed in with an email in SITE_ADMIN_EMAILS (and MFA, unless
 *                ADMIN_REQUIRE_MFA=false): approve requests, manage every space
 *   owner        member with role 'owner': everything in the space, invite editors
 *   editor       member with role 'editor': upload, edit, resolve, invite reviewers
 *   reviewer     anyone with the review link (X-Review-Code): view and comment,
 *                with or without an account
 *   demo owner   X-Space-Key: sk-<id>-<mac>, demos only (no account needed)
 * Approved spaces created before accounts still have space keys; a signed-in user
 * can claim ownership with one (POST /api/s/<id>/claim). Keys keep working for
 * editing until LEGACY_SPACE_KEYS=false.
 * Images use /img/…?t=<exp>.<mac>, a short-lived token from /me, so the review
 * code never goes in a URL.
 *
 * Space keys and review codes are HMACs of the space id under SPACE_SECRET, so no
 * secret is written to the repo. Bumping keyVersion / codeVersion rotates them.
 * Image tokens, the IP salt and the email hash use their own HKDF subkeys.
 *
 * Abuse controls: wrong credentials and writes are rate limited per IP (the
 * AUTH_LIMIT and WRITE_LIMIT bindings, or an in-memory fallback), demo creation
 * needs a Turnstile token when TURNSTILE_SECRET is set, and email has daily caps.
 *
 * Secrets:  GITHUB_TOKEN, SPACE_SECRET, SITE_ADMIN_EMAILS, RESEND_API_KEY (optional),
 *           TURNSTILE_SECRET (optional)
 * Vars:     GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, DEMO_BRANCH, ALLOWED_ORIGINS,
 *           SITE_URL, CLERK_ISSUER, CLERK_JWT_KEY (optional, PEM), EMAIL_FROM,
 *           EMAIL_DAILY_LIMIT, ADMIN_REQUIRE_MFA, LEGACY_SPACE_KEYS,
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
const INVITE_DAYS = 7;
const INVITES_PER_SPACE_PER_DAY = 30;
const EMAILS_PER_RECIPIENT_PER_DAY = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
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
    requestIds.set(request, requestId);
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

  // Cron trigger (see wrangler.toml): delete expired demo spaces, prune old D1 rows.
  async scheduled(event, env, ctx) {
    checkEnv(env);
    ctx.waitUntil(cleanupDemos(env).catch((err) => console.error('demo cleanup failed', err)));
    ctx.waitUntil(pruneD1(env).catch((err) => console.error('D1 prune failed', err)));
  },
};

const requestIds = new WeakMap(); // request -> id, for logs and the audit table

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
  if (a === 'me' && !rest.length && method === 'GET') return json(await accountOverview(env, request));
  if (a === 'invites' && rest[0]) {
    if (rest.length === 1 && method === 'GET') return json(await invitePreview(env, rest[0]));
    if (rest[1] === 'accept' && rest.length === 2 && method === 'POST') return json(await acceptInvite(env, request, rest[0]));
  }
  if (a === 'demo' && method === 'POST') {
    await verifyTurnstile(env, request);
    return json(await createDemo(env, request), 201);
  }
  if (a === 'requests') return requestRoutes(request, env, rest, method);
  if (a === 'admin') {
    if (!(await isSiteAdmin(request, env))) throw new HttpError(403, 'Site admins only. Sign in with an admin account (with two-step verification).');
    return adminRoutes(request, env, rest, method);
  }
  if (a === 's' && rest[0]) return spaceRoutes(request, env, rest[0], rest.slice(1), method);
  throw new HttpError(404, 'Not found');
}

async function spaceRoutes(request, env, id, p, method) {
  const ctx = await access(request, env, id);
  const { sp } = ctx;
  const [a, b, c, d, e] = p;

  if (a === 'claim' && !b && method === 'POST') return json(await claimSpace(env, request, ctx));

  if (a === 'me' && method === 'GET') {
    return json({
      admin: ctx.admin,
      owner: ctx.owner,
      role: ctx.role,
      siteAdmin: ctx.site,
      signedIn: !!ctx.user,
      // An approved space with a valid key but no owner account yet can be claimed.
      canClaim: !!ctx.user && ctx.keyValid && !isDemoId(id) && ctx.member !== 'owner',
      authorized: ctx.reviewer,
      space: ctx.reviewer ? publicSpace(ctx.idx) : { id, kind: ctx.idx.kind, expiresAt: ctx.idx.expiresAt || null },
      // Admins need the code to build share links.
      reviewCode: ctx.admin ? formatCode(await reviewCode(env, id, ctx.idx)) : null,
      imageToken: ctx.reviewer ? await imageToken(env, ctx.idx) : null,
    });
  }

  if (!ctx.reviewer) throw new HttpError(401, 'Review code required');
  const needAdmin = () => { if (!ctx.admin) throw new HttpError(403, 'Only owners and editors can do this'); };
  const needOwner = () => { if (!ctx.owner) throw new HttpError(403, 'Only owners can do this'); };

  if (a === 'members' && !b && method === 'GET') { needAdmin(); return json(await listMembers(env, ctx)); }
  if (a === 'members' && b && !c) {
    if (method === 'PATCH') { needOwner(); return json(await setMemberRole(env, request, ctx, b, await readBody(request))); }
    // Owners remove anyone; anyone can leave.
    if (method === 'DELETE') {
      if (!ctx.owner && ctx.user?.id !== b) throw new HttpError(403, 'Only owners can do this');
      return json(await removeMember(env, request, ctx, b));
    }
  }
  if (a === 'invites' && !b && method === 'POST') { needAdmin(); return json(await createInvite(env, request, ctx, await readBody(request)), 201); }
  if (a === 'invites' && b && !c && method === 'DELETE') { needOwner(); return json(await revokeInvite(env, request, ctx, b)); }

  if (!a && method === 'DELETE') {
    // Demo owners can delete their demo early; approved spaces are deleted by the site admin.
    needAdmin();
    if (ctx.idx.kind !== 'demo' && !ctx.site) throw new HttpError(403, 'Ask the site admin to delete this space');
    await deleteSpace(env, id);
    await audit(env, request, 'space.delete', { actor: ctx.user?.id, spaceId: id });
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
      if (!d && method === 'POST') return json(await addComment(env, sp, b, await readBody(request), ctx.user), 201);
      if (d && !e && method === 'PATCH') { needAdmin(); return json(await updateComment(env, sp, b, d, await readBody(request))); }
      if (d && !e && method === 'DELETE') { needAdmin(); return json(await deleteComment(env, sp, b, d)); }
    }
  }
  throw new HttpError(404, 'Not found');
}

async function requestRoutes(request, env, p, method) {
  const [id, action] = p;
  if (!id && method === 'POST') return json(await createRequest(env, request), 201);
  // Requests made before accounts: the browser that sent it holds a status token.
  if (id && action === 'status' && method === 'POST') return json(await requestStatus(env, id, await readBody(request)));
  throw new HttpError(404, 'Not found');
}

async function adminRoutes(request, env, p, method) {
  const [a, id, action] = p;
  if (a === 'overview' && !id && method === 'GET') return json(await adminOverview(env));
  if (a === 'cleanup' && !id && method === 'POST') return json(await cleanupDemos(env));

  if (a === 'requests' && id) {
    if (action === 'approve' && method === 'POST') return json(await approveRequest(env, request, id, await readBody(request)), 201);
    if (action === 'reject' && method === 'POST') return json(await rejectRequest(env, request, id, await readBody(request)));
    if (!action && method === 'DELETE') return json(await deleteRequest(env, id));
  }
  if (a === 'audit' && !id && method === 'GET') return json(await auditLog(env, new URL(request.url).searchParams.get('space')));

  if (a === 'spaces') {
    if (!id && method === 'POST') return json(await adminCreateSpace(env, request, await readBody(request)), 201);
    if (id && !SPACE_RE.test(id)) throw new HttpError(400, 'Bad space id');
    if (id && !action) {
      if (method === 'GET') return json(await adminSpaceInfo(env, id));
      if (method === 'PATCH') return json(await adminUpdateSpace(env, id, await readBody(request)));
      if (method === 'DELETE') {
        await deleteSpace(env, id);
        await audit(env, request, 'space.delete', { actor: (await currentUser(env, request))?.id, spaceId: id });
        return json({ ok: true });
      }
    }
    if (id && action === 'keys' && method === 'GET') {
      await audit(env, request, 'space.view_keys', { actor: (await currentUser(env, request))?.id, spaceId: id });
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
      await audit(env, request, 'space.rotate_key', { actor: (await currentUser(env, request))?.id, spaceId: id });
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
    emailEnabled: !!(env.RESEND_API_KEY && env.EMAIL_FROM),
    clerkIssuer: env.CLERK_ISSUER || null,
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
  const user = await currentUser(env, request);
  const site = await isSiteAdmin(request, env);
  const role = user ? await memberRole(env, id, user.id) : null;
  const key = request.headers.get('X-Space-Key');
  const keyValid = !!key && await checkCredential(env, request, `${id}:k`, key, () => spaceKey(env, id, idx.keyVersion));
  // Demos are always run by key. Approved spaces accept keys until LEGACY_SPACE_KEYS=false.
  const keyOk = keyValid && (isDemoId(id) || env.LEGACY_SPACE_KEYS !== 'false');
  const owner = site || role === 'owner' || keyOk;
  const admin = owner || role === 'editor';
  const code = normCode(request.headers.get('X-Review-Code'));
  const reviewer = admin || (!!code && await checkCredential(env, request, `${id}:c`, code, () => reviewCode(env, id, idx)));
  return { sp, idx, user, site, member: role, role: site ? 'site-admin' : role || (keyOk ? 'owner' : null), owner, admin, reviewer, keyValid };
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

/* ------------------------------------------------------------------ sign-in */

/**
 * The signed-in user, from a Clerk session token in `Authorization: Bearer`.
 * Returns null when there is no token. A token that is present but invalid or
 * expired is a 401, so the site knows to refresh it. Cached per request.
 */
const userCache = new WeakMap();
function currentUser(env, request) {
  if (!userCache.has(request)) userCache.set(request, verifySession(env, request));
  return userCache.get(request);
}

async function verifySession(env, request) {
  const h = request.headers.get('Authorization') || '';
  if (!h) return null;
  const m = h.match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  const bad = (why) => {
    console.warn(JSON.stringify({ event: 'session_rejected', why, requestId: requestIds.get(request) }));
    return new HttpError(401, 'Your sign-in has expired. Please sign in again.');
  };
  if (!m) throw bad('format');
  let header, claims;
  try {
    header = JSON.parse(b64urlText(m[1]));
    claims = JSON.parse(b64urlText(m[2]));
  } catch { throw bad('json'); }
  if (header.alg !== 'RS256') throw bad('alg');
  const key = await clerkKey(env, header.kid);
  if (!key || !(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(m[3]), enc.encode(`${m[1]}.${m[2]}`)))) throw bad('signature');
  const t = Date.now() / 1000;
  if (!(claims.exp > t - 5) || (claims.nbf && claims.nbf > t + 5)) throw bad('expired');
  if (claims.iss !== env.CLERK_ISSUER) throw bad('issuer');
  // azp is the site origin that asked Clerk for the token: it stops tokens minted
  // for some other site on the same Clerk instance from working here.
  const origins = allowedOrigins(env);
  if (!origins.includes('*') && !origins.includes(claims.azp)) throw bad('azp');
  if (claims.sts && claims.sts !== 'active') throw bad('status');
  // `email` is what the README asks for; the others are names Clerk's own examples use.
  const email = String(claims.email || claims.primaryEmail || claims.primary_email_address || '').trim().toLowerCase();
  if (!claims.sub || !EMAIL_RE.test(email)) {
    // Claim names only, never values: enough to see what the session token is missing.
    console.warn(JSON.stringify({ event: 'session_missing_email', claims: Object.keys(claims).sort(), requestId: requestIds.get(request) }));
    throw new HttpError(401, 'Your sign-in doesn’t include an email address. (Admin: add the email claim to the Clerk session token; see README.)');
  }
  return {
    id: String(claims.sub),
    email,
    name: cleanText(String(claims.name || claims.fullName || '').slice(0, 200), 200, 'Name', true).slice(0, MAX_NAME),
    // fva = [minutes since first factor, minutes since second factor]; -1 = never.
    mfa: Array.isArray(claims.fva) && Number(claims.fva[1]) >= 0,
  };
}

// Clerk's public key: CLERK_JWT_KEY (PEM) when set, else the issuer's JWKS, cached an hour.
const jwksCache = { at: 0, keys: new Map(), url: '' };
async function clerkKey(env, kid) {
  if (env.CLERK_JWT_KEY) {
    if (jwksCache.url !== `pem:${env.CLERK_JWT_KEY}`) {
      const der = Uint8Array.from(atob(env.CLERK_JWT_KEY.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
      jwksCache.keys = new Map([['*', await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])]]);
      jwksCache.url = `pem:${env.CLERK_JWT_KEY}`;
    }
    return jwksCache.keys.get('*');
  }
  const url = `${env.CLERK_ISSUER}/.well-known/jwks.json`;
  const stale = jwksCache.url !== url || Date.now() - jwksCache.at > 3600e3;
  // An unknown kid can mean Clerk rotated its keys: refetch, at most once a minute.
  if (stale || (!jwksCache.keys.has(kid) && Date.now() - jwksCache.at > 60e3)) {
    const res = await fetch(url);
    if (!res.ok) throw new HttpError(502, `Clerk JWKS fetch failed (${res.status})`);
    const keys = new Map();
    for (const jwk of (await res.json()).keys || []) {
      if (jwk.kty === 'RSA') keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    Object.assign(jwksCache, { at: Date.now(), keys, url });
  }
  return jwksCache.keys.get(kid) || null;
}
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64urlText = (s) => new TextDecoder().decode(b64urlBytes(s));

const siteAdminEmails = (env) => String(env.SITE_ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
async function isSiteAdmin(request, env) {
  const user = await currentUser(env, request);
  if (!user || !siteAdminEmails(env).includes(user.email)) return false;
  return env.ADMIN_REQUIRE_MFA === 'false' || user.mfa;
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
  await env.DB.batch([
    env.DB.prepare('DELETE FROM members WHERE space_id = ?').bind(id),
    env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE space_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').bind(now(), id),
  ]);
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

/** A signed-in user asks for a space. Name and email come from their account. */
async function createRequest(env, request) {
  const s = settings(env);
  const user = await currentUser(env, request);
  if (!user) throw new HttpError(401, 'Please sign in to request a space.');
  const body = await readBody(request);
  const organization = cleanText(body.organization || '', 120, 'Organization', true);
  const purpose = cleanText(body.purpose, 1000, 'Purpose', false, true);
  const plan = body.plan === undefined ? '' : cleanText(body.plan, 40, 'Plan', true);
  await ensureUser(env, user);
  const who = await ipHash(env, request);
  const id = newId();

  await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
    reg = reg || { requests: [] };
    const pending = reg.requests.filter((r) => r.status === 'pending');
    if (pending.length >= s.maxPending) throw new HttpError(429, 'We have a lot of requests waiting. Please try again in a few days.');
    if (pending.filter((r) => r.userId === user.id || r.ipHash === who).length >= 3) throw new HttpError(429, 'You already have requests waiting for review.');
    reg.requests.push({
      id, userId: user.id, name: user.name || user.email, email: user.email, organization, purpose,
      ...(plan ? { plan } : {}), status: 'pending', createdAt: now(), ipHash: who,
    });
    return reg;
  }, 'requests: new space request', true);
  await audit(env, request, 'request.create', { actor: user.id, detail: { requestId: id } });
  return { id, status: 'pending' };
}

async function findRequest(env, id) {
  const reg = await readJson(env, dataBranch(env), REQUESTS_REG);
  return reg?.requests.find((r) => r.id === id) || null;
}

/**
 * Status of a request made before accounts, for the browser holding its token.
 * Keys of an approved space are handed out once, then hidden.
 */
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

/**
 * Creates the space and makes the requester its owner, then emails them. Requests
 * from before accounts have no user: the admin gets the space key to pass on.
 */
async function approveRequest(env, request, id, body) {
  const s = settings(env);
  const admin = await currentUser(env, request);
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
    if (req.userId) await addMember(env, spaceId, req.userId, 'owner', 'request');
  } catch (err) {
    await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
      const r = reg.requests.find((x) => x.id === id);
      if (r) Object.assign(r, { status: 'pending', spaceId: null, decidedAt: null });
      return reg;
    }, 'requests: undo approve').catch(() => {});
    throw err;
  }
  await registerSpace(env, { id: spaceId, title, owner: req.name, email: req.email, requestId: id });
  await audit(env, request, 'request.approve', { actor: admin?.id, spaceId, detail: { requestId: id } });
  if (!req.userId) return { ...created, legacy: true };

  const mail = await sendEmail(env, request, {
    kind: 'request-approved', to: req.email, spaceId,
    ...emailRequestApproved({ title, link: spaceLink(env, spaceId) }),
  });
  const { adminKey: _k, ...rest } = created;
  return { ...rest, owner: req.email, ...mail };
}

async function rejectRequest(env, request, id, body) {
  const reason = cleanText(body.reason || '', 500, 'Reason', true, true);
  let req;
  await updateJson(env, dataBranch(env), REQUESTS_REG, (reg) => {
    req = must(reg?.requests.find((x) => x.id === id), 'Request');
    if (req.status !== 'pending') throw new HttpError(409, `This request was already ${req.status}`);
    Object.assign(req, { status: 'rejected', reason, decidedAt: now() });
    return reg;
  }, 'requests: reject');
  await audit(env, request, 'request.reject', { actor: (await currentUser(env, request))?.id, detail: { requestId: id } });
  const mail = req.userId
    ? await sendEmail(env, request, { kind: 'request-rejected', to: req.email, ...emailRequestRejected({ reason }) })
    : {};
  return { ok: true, ...mail };
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

/** The admin creates a space and, optionally, invites its owner by email. */
async function adminCreateSpace(env, request, body) {
  const admin = await currentUser(env, request);
  const title = cleanText(body.title, 120, 'Title');
  const email = cleanText(body.email || '', 200, 'Email', true).toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address');
  const quotaBytes = quotaFrom(body.quotaMb, settings(env).spaceQuota);
  const id = newSpaceId('s');
  const { adminKey: _k, ...created } = await createSpace(env, id, { kind: 'space', title, quotaBytes });
  await registerSpace(env, { id, title, owner: '', email, requestId: null });
  await audit(env, request, 'space.create', { actor: admin.id, spaceId: id });
  if (!email) return created;
  await ensureUser(env, admin);
  const invite = await makeInvite(env, request, { spaceId: id, title, email, role: 'owner', inviter: admin });
  return { ...created, invite };
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

/* ----------------------------------------------------------------- accounts */

const siteUrl = (env) => (env.SITE_URL.endsWith('/') ? env.SITE_URL : `${env.SITE_URL}/`);
const spaceLink = (env, id) => `${siteUrl(env)}#/${id}`;
const reviewLinkFor = (env, id, code) => `${siteUrl(env)}?code=${encodeURIComponent(code)}#/${id}`;
// The token sits in the fragment, so it is never sent to a server or in a Referer.
const inviteLink = (env, token) => `${siteUrl(env)}#/invite/${token}`;
const displayName = (user) => user?.name || user?.email || 'Someone';
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/** Keeps the users row in step with Clerk (email and name can change there). */
async function ensureUser(env, user) {
  await env.DB.prepare(`INSERT INTO users (id, email, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name, last_seen = excluded.last_seen`)
    .bind(user.id, user.email, user.name, now(), now()).run();
}

async function memberRole(env, spaceId, userId) {
  return (await env.DB.prepare('SELECT role FROM members WHERE space_id = ? AND user_id = ?').bind(spaceId, userId).first('role')) || null;
}

// Adds a member; an existing owner is never demoted by a later editor invite.
function addMemberStmt(env, spaceId, userId, role, addedBy) {
  return env.DB.prepare(`INSERT INTO members (space_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (space_id, user_id) DO UPDATE SET role = CASE WHEN members.role = 'owner' THEN 'owner' ELSE excluded.role END`)
    .bind(spaceId, userId, role, addedBy, now());
}
const addMember = (env, ...args) => addMemberStmt(env, ...args).run();

/** GET /api/me: who is signed in, their spaces and their space requests. */
async function accountOverview(env, request) {
  const user = await currentUser(env, request);
  if (!user) return { signedIn: false };
  await ensureUser(env, user);
  const [rows, reg, reqs] = await Promise.all([
    env.DB.prepare('SELECT space_id, role, created_at FROM members WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all(),
    readJson(env, dataBranch(env), SPACES_REG),
    readJson(env, dataBranch(env), REQUESTS_REG),
  ]);
  const titles = new Map((reg?.spaces || []).map((x) => [x.id, x.title]));
  const isAdminEmail = siteAdminEmails(env).includes(user.email);
  return {
    signedIn: true,
    user: { id: user.id, email: user.email, name: user.name },
    siteAdmin: await isSiteAdmin(request, env),
    // Lets the site explain why an admin account isn't getting the console.
    adminNeedsMfa: isAdminEmail && !user.mfa && env.ADMIN_REQUIRE_MFA !== 'false',
    spaces: rows.results.filter((r) => titles.has(r.space_id)).map((r) => ({ id: r.space_id, title: titles.get(r.space_id), role: r.role })),
    requests: (reqs?.requests || []).filter((r) => r.userId === user.id).reverse().map((r) => ({
      id: r.id, status: r.status, organization: r.organization, createdAt: r.createdAt,
      decidedAt: r.decidedAt || null, reason: r.reason || '', spaceId: r.spaceId || null,
    })),
  };
}

/* ------------------------------------------------------------------ members */

async function listMembers(env, ctx) {
  const id = ctx.sp.id;
  const [members, invites] = await Promise.all([
    env.DB.prepare(`SELECT m.user_id AS id, m.role, m.created_at AS addedAt, u.email, u.name
      FROM members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.created_at`).bind(id).all(),
    env.DB.prepare(`SELECT id, email, role, created_at AS createdAt, expires_at AS expiresAt FROM invites
      WHERE space_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`).bind(id, now()).all(),
  ]);
  return { members: members.results, invites: invites.results, you: ctx.user?.id || null };
}

// "Not the last owner" is checked inside the same statement, so two owners can't
// both step down at once and leave the space without one.
const LAST_OWNER_GUARD = `(role <> 'owner' OR (SELECT COUNT(*) FROM members WHERE space_id = ?1 AND role = 'owner') > 1)`;

async function setMemberRole(env, request, ctx, userId, body) {
  const role = body.role;
  if (!['owner', 'editor'].includes(role)) throw new HttpError(400, 'Role must be owner or editor');
  const r = await env.DB.prepare(`UPDATE members SET role = ?3 WHERE space_id = ?1 AND user_id = ?2 AND (?3 = 'owner' OR ${LAST_OWNER_GUARD})`)
    .bind(ctx.sp.id, userId, role).run();
  if (!r.meta.changes) {
    if (!(await memberRole(env, ctx.sp.id, userId))) throw new HttpError(404, 'Member not found');
    throw new HttpError(409, 'A space needs at least one owner');
  }
  await audit(env, request, 'member.role', { actor: ctx.user?.id, spaceId: ctx.sp.id, detail: { userId, role } });
  return listMembers(env, ctx);
}

async function removeMember(env, request, ctx, userId) {
  const r = await env.DB.prepare(`DELETE FROM members WHERE space_id = ?1 AND user_id = ?2 AND ${LAST_OWNER_GUARD}`).bind(ctx.sp.id, userId).run();
  if (!r.meta.changes) {
    if (!(await memberRole(env, ctx.sp.id, userId))) throw new HttpError(404, 'Member not found');
    throw new HttpError(409, 'A space needs at least one owner');
  }
  await audit(env, request, ctx.user?.id === userId ? 'member.leave' : 'member.remove', { actor: ctx.user?.id, spaceId: ctx.sp.id, detail: { userId } });
  return listMembers(env, ctx);
}

/* ------------------------------------------------------------------ invites */

/**
 * POST /api/s/<id>/invites { email, role }.
 *   reviewer        emails the review link (no account needed); owners and editors
 *   editor / owner  emails a single-use invite for that address; owners only
 * The response always includes the link, so it can be shared another way when
 * email isn't set up or fails.
 */
async function createInvite(env, request, ctx, body) {
  if (!ctx.user) throw new HttpError(401, 'Please sign in to invite people.');
  const email = cleanText(body.email, 200, 'Email').toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address');
  const { id } = ctx.sp;

  if (body.role === 'reviewer') {
    const code = formatCode(await reviewCode(env, id, ctx.idx));
    const link = reviewLinkFor(env, id, code);
    // Demos need no approval, so they don't get to send email on our behalf.
    if (isDemoId(id)) return { kind: 'review-link', link, emailed: false, emailNote: 'Demo spaces can’t send email, so copy the link and send it yourself.' };
    const mail = await sendEmail(env, request, {
      kind: 'review-link', to: email, spaceId: id,
      ...emailReviewLink({ inviter: displayName(ctx.user), title: ctx.idx.title, link, code }),
    });
    await audit(env, request, 'invite.reviewer', { actor: ctx.user.id, spaceId: id, detail: { emailed: mail.emailed } });
    return { kind: 'review-link', link, ...mail };
  }

  if (!['owner', 'editor'].includes(body.role)) throw new HttpError(400, 'Role must be reviewer, editor or owner');
  if (!ctx.owner) throw new HttpError(403, 'Only owners can invite editors and owners');
  if (isDemoId(id)) throw new HttpError(400, 'Demo spaces can’t have editors. Request a space to work as a team.');
  const existing = await env.DB.prepare('SELECT m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? AND u.email = ?').bind(id, email).first('role');
  if (existing === 'owner' || existing === body.role) throw new HttpError(409, 'That person is already a member');
  await ensureUser(env, ctx.user);
  return { kind: 'invite', ...(await makeInvite(env, request, { spaceId: id, title: ctx.idx.title, email, role: body.role, inviter: ctx.user })) };
}

async function makeInvite(env, request, { spaceId, title, email, role, inviter }) {
  const since = new Date(Date.now() - 86400e3).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE space_id = ? AND created_at > ?').bind(spaceId, since).first('n');
  if (recent >= INVITES_PER_SPACE_PER_DAY) throw new HttpError(429, `A space can send up to ${INVITES_PER_SPACE_PER_DAY} invites a day.`);

  const token = randomToken();
  const id = newId();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400e3).toISOString();
  // A new invite replaces any pending one for the same person.
  await env.DB.batch([
    env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE space_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL').bind(createdAt, spaceId, email),
    env.DB.prepare(`INSERT INTO invites (id, space_id, email, role, token_hash, invited_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, spaceId, email, role, await sha256hex(token), inviter.id, createdAt, expiresAt),
  ]);
  const link = inviteLink(env, token);
  const mail = await sendEmail(env, request, {
    kind: 'invite', to: email, spaceId,
    ...emailInvite({ inviter: displayName(inviter), title, role, link, expiresAt }),
  });
  await audit(env, request, 'invite.create', { actor: inviter.id, spaceId, detail: { inviteId: id, role, emailed: mail.emailed } });
  return { invite: { id, email, role, createdAt, expiresAt }, link, ...mail };
}

async function revokeInvite(env, request, ctx, inviteId) {
  const r = await env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND space_id = ? AND accepted_at IS NULL AND revoked_at IS NULL')
    .bind(now(), inviteId, ctx.sp.id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Invite not found');
  await audit(env, request, 'invite.revoke', { actor: ctx.user?.id, spaceId: ctx.sp.id, detail: { inviteId } });
  return listMembers(env, ctx);
}

async function findInvite(env, token) {
  if (!TOKEN_RE.test(String(token))) throw new HttpError(404, 'This invite link isn’t valid. Check that you copied all of it.');
  const row = await env.DB.prepare(`SELECT i.*, u.name AS inviter_name, u.email AS inviter_email FROM invites i
    LEFT JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ?`).bind(await sha256hex(token)).first();
  if (!row) throw new HttpError(404, 'This invite link isn’t valid. Check that you copied all of it.');
  const status = row.accepted_at ? 'accepted' : row.revoked_at ? 'revoked' : row.expires_at <= now() ? 'expired' : 'pending';
  return { row, status };
}

/** GET /api/invites/<token>: what the invite is for, before signing in. */
async function invitePreview(env, token) {
  const { row, status } = await findInvite(env, token);
  const idx = await readJson(env, dataBranch(env), `spaces/${row.space_id}/index.json`);
  if (!idx) throw new HttpError(410, 'The space this invite was for has been deleted.');
  return {
    spaceId: row.space_id, title: idx.title, role: row.role, status, expiresAt: row.expires_at,
    inviter: row.inviter_name || row.inviter_email || 'Someone', email: maskEmail(row.email),
  };
}

/** POST /api/invites/<token>/accept: only works for the invited email address. */
async function acceptInvite(env, request, token) {
  const user = await currentUser(env, request);
  if (!user) throw new HttpError(401, 'Please sign in to accept this invite.');
  const { row, status } = await findInvite(env, token);
  if (status !== 'pending') throw new HttpError(410, `This invite has ${status === 'accepted' ? 'already been used' : status === 'revoked' ? 'been cancelled' : 'expired'}. Ask for a new one.`);
  if (row.email !== user.email) {
    await audit(env, request, 'invite.wrong_account', { actor: user.id, spaceId: row.space_id, detail: { inviteId: row.id } });
    throw new HttpError(403, `This invite was sent to ${maskEmail(row.email)}. Sign in with that email address to accept it.`);
  }
  await ensureUser(env, user);
  // Mark it used first: of two simultaneous accepts, only one changes the row.
  const used = await env.DB.prepare('UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL')
    .bind(now(), user.id, row.id).run();
  if (!used.meta.changes) throw new HttpError(410, 'This invite has already been used.');
  await addMember(env, row.space_id, user.id, row.role, row.invited_by);
  await audit(env, request, 'invite.accept', { actor: user.id, spaceId: row.space_id, detail: { inviteId: row.id, role: row.role } });
  return { spaceId: row.space_id, role: row.role };
}

/**
 * POST /api/s/<id>/claim with X-Space-Key: a signed-in user who holds the key of
 * an approved space becomes an owner. The key is then rotated, so it stops working;
 * teammates who used it get invited instead.
 */
async function claimSpace(env, request, ctx) {
  if (!ctx.user) throw new HttpError(401, 'Please sign in first.');
  if (isDemoId(ctx.sp.id)) throw new HttpError(400, 'Demo spaces can’t be claimed. Request a space to keep your work.');
  if (!ctx.keyValid) throw new HttpError(403, 'That space key is not correct.');
  await ensureUser(env, ctx.user);
  await addMember(env, ctx.sp.id, ctx.user.id, 'owner', 'claim');
  await updateJson(env, ctx.sp.br, indexPath(ctx.sp), (x) => {
    must(x, 'Space');
    x.keyVersion = (x.keyVersion || 1) + 1;
    return x;
  }, 'review: space claimed, key retired');
  authCache.delete(ctx.sp.id);
  await audit(env, request, 'space.claim', { actor: ctx.user.id, spaceId: ctx.sp.id });
  return { ok: true, role: 'owner' };
}

/* -------------------------------------------------------------------- audit */

/** Appends to the audit table. Never fails the request: a failure is logged instead. */
async function audit(env, request, action, { actor, spaceId, detail } = {}) {
  try {
    await env.DB.prepare('INSERT INTO audit (at, request_id, actor, ip_hash, action, space_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(now(), requestIds.get(request) || null, actor || 'anon', await ipHash(env, request), action, spaceId || null,
        detail ? JSON.stringify(detail).slice(0, 2000) : null)
      .run();
  } catch (err) {
    console.error(JSON.stringify({ event: 'audit_write_failed', action, error: String(err?.message || err) }));
  }
}

async function auditLog(env, spaceId) {
  const where = spaceId ? 'WHERE a.space_id = ?' : '';
  const stmt = env.DB.prepare(`SELECT a.at, a.action, a.space_id AS spaceId, a.detail, a.request_id AS requestId,
    COALESCE(u.email, a.actor) AS actor FROM audit a LEFT JOIN users u ON u.id = a.actor ${where} ORDER BY a.id DESC LIMIT 200`);
  const rows = (await (spaceId ? stmt.bind(spaceId) : stmt).all()).results;
  return { entries: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) };
}

// Hourly: drop email logs after 30 days, finished invites after 90, audit entries after a year.
async function pruneD1(env) {
  const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_log WHERE at < ?').bind(ago(30)),
    env.DB.prepare('DELETE FROM invites WHERE COALESCE(accepted_at, revoked_at, expires_at) < ?').bind(ago(90)),
    env.DB.prepare('DELETE FROM audit WHERE at < ?').bind(ago(365)),
  ]);
}

/* -------------------------------------------------------------------- email */

/**
 * Sends one email through Resend. Never throws: the caller gets { emailed, emailNote }
 * and always has a link to share another way. Limits: EMAIL_DAILY_LIMIT in total
 * (default 90, under Resend's free 100/day) and a few per recipient per day.
 */
async function sendEmail(env, request, { kind, to, subject, text, html, spaceId }) {
  const toHash = b64url(await hmacRaw(await subkey(env, 'email-hash'), to.toLowerCase())).slice(0, 22);
  const log = (status) => env.DB.prepare('INSERT INTO email_log (at, kind, space_id, to_hash, status) VALUES (?, ?, ?, ?, ?)')
    .bind(now(), kind, spaceId || null, toHash, status).run().catch(() => {});
  const skip = async (emailNote) => { await log('skipped'); return { emailed: false, emailNote }; };

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return skip('Email isn’t set up yet, so copy the link and send it yourself.');
  const since = new Date(Date.now() - 86400e3).toISOString();
  const [total, mine, fromSpace] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE at > ? AND status = 'sent'").bind(since).first('n'),
    env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE at > ? AND to_hash = ? AND status = 'sent'").bind(since, toHash).first('n'),
    spaceId ? env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE at > ? AND space_id = ? AND status = 'sent'").bind(since, spaceId).first('n') : 0,
  ]);
  if (total >= (Number(env.EMAIL_DAILY_LIMIT) > 0 ? Number(env.EMAIL_DAILY_LIMIT) : 90)) return skip('Today’s email limit is reached, so copy the link and send it yourself.');
  if (mine >= EMAILS_PER_RECIPIENT_PER_DAY) return skip('That address has had several emails from us today, so copy the link and send it yourself.');
  // One space can't use up everyone's daily allowance.
  if (fromSpace >= INVITES_PER_SPACE_PER_DAY) return skip('This space has sent a lot of email today, so copy the link and send it yourself.');

  let ok = false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `${requestIds.get(request) || newId()}-${kind}-${toHash}`,
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: oneLine(subject, 150), text, html }),
    });
    ok = res.ok;
    if (!ok) console.error(JSON.stringify({ event: 'email_failed', kind, status: res.status, body: (await res.text()).slice(0, 300) }));
  } catch (err) {
    console.error(JSON.stringify({ event: 'email_failed', kind, error: String(err?.message || err) }));
  }
  await log(ok ? 'sent' : 'failed');
  return ok ? { emailed: true } : { emailed: false, emailNote: 'The email couldn’t be sent, so copy the link and send it yourself.' };
}

const oneLine = (s, max) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const quoteTitle = (t) => `“${oneLine(t, 60)}”`;
const fmtDate = (iso) => new Date(iso).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');

// Plain text plus simple HTML. User-supplied text (names, titles, reasons) is escaped.
function emailBody({ heading, lines, button, footer }) {
  const text = [heading, '', ...lines, '', button ? `${button.label}: ${button.url}` : '', '', footer].filter((x) => x !== undefined).join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e1c1a">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<h1 style="font-size:18px;margin:0 0 16px">${escHtml(heading)}</h1>
${lines.map((l) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escHtml(l)}</p>`).join('\n')}
${button ? `<p style="margin:20px 0"><a href="${escHtml(button.url)}" style="background:#e8590c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${escHtml(button.label)}</a></p>
<p style="font-size:12px;color:#6b6560;word-break:break-all">Or paste this link into your browser: ${escHtml(button.url)}</p>` : ''}
<p style="font-size:12px;color:#6b6560;margin-top:20px">${escHtml(footer)}</p>
</div></body></html>`;
  return { text, html };
}

const IGNORE = 'If you weren’t expecting this, you can ignore this email.';

function emailInvite({ inviter, title, role, link, expiresAt }) {
  const what = role === 'owner' ? 'an owner of' : 'an editor of';
  return {
    subject: `${oneLine(inviter, 60)} invited you to ${quoteTitle(title)} on Review Desk`,
    ...emailBody({
      heading: `You’re invited to ${quoteTitle(title)}`,
      lines: [
        `${oneLine(inviter, 60)} invited you to be ${what} this space on Review Desk, where your team collects feedback on screenshots.`,
        `Sign in with this email address to accept. The invite expires on ${fmtDate(expiresAt)}.`,
      ],
      button: { label: 'Accept the invite', url: link },
      footer: IGNORE,
    }),
  };
}

function emailReviewLink({ inviter, title, link }) {
  return {
    subject: `${oneLine(inviter, 60)} asked for your feedback on ${quoteTitle(title)}`,
    ...emailBody({
      heading: `Your feedback on ${quoteTitle(title)}`,
      lines: [
        `${oneLine(inviter, 60)} shared screenshots with you on Review Desk and would like your comments.`,
        'Open the link to view them and comment on a whole section or on an exact spot. You don’t need an account.',
      ],
      button: { label: 'Open the screenshots', url: link },
      footer: `Anyone with this link can view and comment, so please don’t forward it. ${IGNORE}`,
    }),
  };
}

function emailRequestApproved({ title, link }) {
  return {
    subject: `Your Review Desk space ${quoteTitle(title)} is ready`,
    ...emailBody({
      heading: 'Your space is ready',
      lines: [`Your request was approved. You’re the owner of ${quoteTitle(title)}: sign in to upload screenshots and invite your team.`],
      button: { label: 'Open your space', url: link },
      footer: 'You’re getting this because you requested a space on Review Desk.',
    }),
  };
}

function emailRequestRejected({ reason }) {
  return {
    subject: 'About your Review Desk space request',
    ...emailBody({
      heading: 'We couldn’t approve your request',
      lines: [
        'Thanks for your interest in Review Desk. We weren’t able to approve your space request this time.',
        ...(reason ? [`Reason: ${oneLine(reason, 500)}`] : []),
      ],
      footer: 'You’re getting this because you requested a space on Review Desk.',
    }),
  };
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

/** Signed-in people comment under their account name; others type a name. */
async function addComment(env, sp, sectionId, body, user) {
  const author = user ? displayName(user).slice(0, MAX_NAME) : cleanText(body.author, MAX_NAME, 'Name');
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
    s.comments.push({ id: newId(), target, parentId, author, ...(user ? { authorId: user.id, verified: true } : {}), text, pin, createdAt: now(), resolved: false });
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
  const missing = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'SPACE_SECRET', 'CLERK_ISSUER', 'SITE_URL', 'DB'].filter((k) => !env[k]);
  if (missing.length) throw new HttpError(500, `Worker not configured: missing ${missing.join(', ')}`);
}

// Only origins listed in ALLOWED_ORIGINS get CORS headers; unset means no browser
// origin is allowed. '*' is for local development only.
const allowedOrigins = (env) => String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
function corsHeaders(env, origin) {
  const allowed = allowedOrigins(env);
  const allow = allowed.includes('*') ? '*' : (origin && allowed.includes(origin) ? origin : null);
  if (!allow) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Space-Key, X-Review-Code, X-Turnstile-Token',
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
const now = () => new Date(Date.now()).toISOString();
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
