/**
 * Screenshot Review API — Cloudflare Worker
 *
 * The GitHub Pages site is static, so it can't hold a GitHub token. This Worker
 * holds it and does every write: sections, screenshots and comments are all
 * committed to a branch of your repo (default: `review-data`).
 *
 *   data/index.json              project title + section order
 *   data/sections/<id>.json      a section, its images and its comments
 *   images/<sectionId>/<file>    the screenshots themselves
 *
 * Secrets:  GITHUB_TOKEN, ADMIN_KEY, REVIEW_CODE (optional)
 * Vars:     GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, ALLOWED_ORIGINS, PUBLIC_IMAGES
 */

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_COMMENT = 2000;
const MAX_NAME = 60;
const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
const INDEX_PATH = 'data/index.json';
const sectionPath = (id) => `data/sections/${id}.json`;
const ID_RE = /^[a-z0-9]{6,40}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      res = await route(request, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error(err);
      res = json({ error: err instanceof HttpError ? err.message : `Server error: ${err.message}` }, status);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },
};

/* ------------------------------------------------------------------ routing */

async function route(request, env) {
  checkEnv(env);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method;
  const admin = isAdmin(request, env);
  const canRead = admin || hasReviewCode(request, url, env);

  if (parts[0] === 'img' && method === 'GET') {
    if (!canRead) throw new HttpError(401, 'Review code required');
    return serveImage(env, parts.slice(1).join('/'));
  }
  if (parts[0] !== 'api') throw new HttpError(404, 'Not found');
  const [, a, b, c, d, e] = parts;

  if (a === 'me' && method === 'GET') {
    return json({
      admin,
      authorized: canRead,
      codeRequired: !!env.REVIEW_CODE,
      imageBase: env.PUBLIC_IMAGES === 'true'
        ? `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${branch(env)}/`
        : null,
    });
  }

  if (!canRead) throw new HttpError(401, 'Review code required');
  const needAdmin = () => { if (!admin) throw new HttpError(403, 'Admin key required'); };

  if (a === 'project' && !b) {
    if (method === 'GET') return json(await loadProject(env));
    if (method === 'PATCH') {
      needAdmin();
      const body = await readBody(request);
      const title = cleanText(body.title, 120, 'Title');
      await updateJson(env, INDEX_PATH, (idx) => ({ ...(idx || defaultIndex()), title }), 'review: rename project', true);
      return json(await loadProject(env));
    }
  }

  if (a === 'sections') {
    if (!b && method === 'POST') { needAdmin(); return json(await createSection(env, await readBody(request)), 201); }
    if (b && !ID_RE.test(b)) throw new HttpError(400, 'Bad section id');

    if (b && !c) {
      if (method === 'PATCH') { needAdmin(); return json(await updateSection(env, b, await readBody(request))); }
      if (method === 'DELETE') { needAdmin(); await deleteSection(env, b); return json({ ok: true }); }
    }
    if (b && c === 'images') {
      if (!d && method === 'POST') { needAdmin(); return json(await uploadImage(env, b, await readBody(request)), 201); }
      if (d && !e && method === 'PATCH') { needAdmin(); return json(await updateImage(env, b, d, await readBody(request))); }
      if (d && !e && method === 'DELETE') { needAdmin(); return json(await deleteImage(env, b, d)); }
    }
    if (b && c === 'comments') {
      if (!d && method === 'POST') return json(await addComment(env, b, await readBody(request)), 201);
      if (d && !e && method === 'PATCH') { needAdmin(); return json(await updateComment(env, b, d, await readBody(request))); }
      if (d && !e && method === 'DELETE') { needAdmin(); return json(await deleteComment(env, b, d)); }
    }
  }
  throw new HttpError(404, 'Not found');
}

/* ----------------------------------------------------------------- handlers */

const defaultIndex = () => ({ title: 'Design Review', sections: [] });

async function loadProject(env) {
  const idx = (await readJson(env, INDEX_PATH)) || defaultIndex();
  const sections = await Promise.all(idx.sections.map((id) => readJson(env, sectionPath(id))));
  return { title: idx.title, sections: sections.filter(Boolean) };
}

async function createSection(env, body) {
  const section = {
    id: newId(),
    title: cleanText(body.title, 120, 'Title'),
    description: cleanText(body.description || '', 1000, 'Description', true),
    createdAt: now(),
    images: [],
    comments: [],
  };
  await putFile(env, sectionPath(section.id), b64encodeUtf8(pretty(section)), `review: add section "${section.title}"`);
  await updateJson(env, INDEX_PATH, (idx) => {
    idx = idx || defaultIndex();
    idx.sections.push(section.id);
    return idx;
  }, `review: list section "${section.title}"`, true);
  return section;
}

async function updateSection(env, id, body) {
  return updateJson(env, sectionPath(id), (s) => {
    must(s, 'Section');
    if (body.title !== undefined) s.title = cleanText(body.title, 120, 'Title');
    if (body.description !== undefined) s.description = cleanText(body.description, 1000, 'Description', true);
    return s;
  }, 'review: edit section');
}

async function deleteSection(env, id) {
  const section = await readJson(env, sectionPath(id));
  if (section) {
    for (const img of section.images) await deleteFileIfExists(env, img.path, `review: delete ${img.path}`);
    await deleteFileIfExists(env, sectionPath(id), `review: delete section "${section.title}"`);
  }
  await updateJson(env, INDEX_PATH, (idx) => {
    idx = idx || defaultIndex();
    idx.sections = idx.sections.filter((s) => s !== id);
    return idx;
  }, 'review: unlist section', true);
}

async function uploadImage(env, sectionId, body) {
  const filename = String(body.filename || 'screenshot.png');
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (!IMAGE_TYPES[ext]) throw new HttpError(400, 'Only PNG, JPG, GIF and WebP images are supported');
  const data = String(body.data || '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new HttpError(400, 'Image data missing or not base64');
  if (Math.floor(data.length * 3 / 4) > MAX_IMAGE_BYTES) throw new HttpError(413, 'Image is larger than 15 MB');

  const section = await readJson(env, sectionPath(sectionId));
  must(section, 'Section');

  const id = newId();
  const slug = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'screenshot';
  const path = `images/${sectionId}/${id}-${slug}.${ext === 'jpeg' ? 'jpg' : ext}`;
  await putFile(env, path, data, `review: upload ${filename} to "${section.title}"`);

  return updateJson(env, sectionPath(sectionId), (s) => {
    must(s, 'Section');
    s.images.push({
      id, path,
      name: filename.slice(0, 200),
      caption: cleanText(body.caption || '', 200, 'Caption', true),
      uploadedAt: now(),
    });
    return s;
  }, `review: add screenshot to "${section.title}"`);
}

async function updateImage(env, sectionId, imageId, body) {
  return updateJson(env, sectionPath(sectionId), (s) => {
    must(s, 'Section');
    const img = must(s.images.find((i) => i.id === imageId), 'Screenshot');
    if (body.caption !== undefined) img.caption = cleanText(body.caption, 200, 'Caption', true);
    return s;
  }, 'review: edit caption');
}

async function deleteImage(env, sectionId, imageId) {
  let removed;
  const section = await updateJson(env, sectionPath(sectionId), (s) => {
    must(s, 'Section');
    removed = must(s.images.find((i) => i.id === imageId), 'Screenshot');
    s.images = s.images.filter((i) => i.id !== imageId);
    s.comments = s.comments.filter((c) => c.target !== imageId);
    return s;
  }, 'review: remove screenshot');
  await deleteFileIfExists(env, removed.path, `review: delete ${removed.path}`);
  return section;
}

async function addComment(env, sectionId, body) {
  const author = cleanText(body.author, MAX_NAME, 'Name');
  const text = cleanText(body.text, MAX_COMMENT, 'Comment');
  const parentId = body.parentId ? String(body.parentId) : null;

  return updateJson(env, sectionPath(sectionId), (s) => {
    must(s, 'Section');
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
  }, `review: comment by ${author}`);
}

async function updateComment(env, sectionId, commentId, body) {
  return updateJson(env, sectionPath(sectionId), (s) => {
    must(s, 'Section');
    const c = must(s.comments.find((x) => x.id === commentId), 'Comment');
    if (body.resolved !== undefined) {
      c.resolved = !!body.resolved;
      c.resolvedAt = c.resolved ? now() : null;
    }
    return s;
  }, 'review: update comment status');
}

async function deleteComment(env, sectionId, commentId) {
  return updateJson(env, sectionPath(sectionId), (s) => {
    must(s, 'Section');
    must(s.comments.find((x) => x.id === commentId), 'Comment');
    s.comments = s.comments.filter((x) => x.id !== commentId && x.parentId !== commentId);
    return s;
  }, 'review: delete comment');
}

async function serveImage(env, path) {
  if (!path.startsWith('images/') || path.includes('..')) throw new HttpError(400, 'Bad image path');
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (!IMAGE_TYPES[ext]) throw new HttpError(400, 'Bad image type');
  const res = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch(env))}`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (res.status === 404) throw new HttpError(404, 'Image not found');
  if (!res.ok) throw new HttpError(502, `GitHub image read failed (${res.status})`);
  return new Response(res.body, {
    headers: {
      'Content-Type': IMAGE_TYPES[ext],
      // Image paths contain a unique id, so they never change.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

/* ------------------------------------------------------------ GitHub layer */

const branch = (env) => env.GITHUB_BRANCH || 'review-data';
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'screenshot-review-worker',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
}

/** Returns { sha, text } for a small text file, or null if it doesn't exist. */
async function getTextFile(env, path) {
  const res = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch(env))}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, githubHint(res.status, 'read'));
  const meta = await res.json();
  if (meta.encoding === 'base64' && meta.content) {
    return { sha: meta.sha, text: b64decodeUtf8(meta.content.replace(/\n/g, '')) };
  }
  // Files over 1 MB come back without inline content.
  const raw = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch(env))}`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (!raw.ok) throw new HttpError(502, githubHint(raw.status, 'read'));
  return { sha: meta.sha, text: await raw.text() };
}

async function readJson(env, path) {
  const f = await getTextFile(env, path);
  return f ? JSON.parse(f.text) : null;
}

async function putFile(env, path, base64, message, sha) {
  const res = await gh(env, `/contents/${encodePath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64, branch: branch(env), ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    const err = new HttpError(502, githubHint(res.status, 'write'));
    err.ghStatus = res.status;
    throw err;
  }
  return res.json();
}

async function deleteFileIfExists(env, path, message) {
  const res = await gh(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch(env))}`);
  if (res.status === 404) return;
  if (!res.ok) throw new HttpError(502, githubHint(res.status, 'read'));
  const { sha } = await res.json();
  const del = await gh(env, `/contents/${encodePath(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: branch(env) }),
  });
  if (!del.ok && del.status !== 404) throw new HttpError(502, githubHint(del.status, 'delete'));
}

/**
 * Read-modify-write a JSON file with optimistic locking. Several people may
 * comment at once; GitHub rejects a write with a stale sha (409/422), so we
 * re-read and re-apply the change.
 */
async function updateJson(env, path, mutate, message, allowCreate = false) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const file = await getTextFile(env, path);
    if (!file && !allowCreate) throw new HttpError(404, 'Not found');
    const current = file ? JSON.parse(file.text) : null;
    const next = mutate(current);
    try {
      await putFile(env, path, b64encodeUtf8(pretty(next)), message, file?.sha);
      return next;
    } catch (err) {
      if (err.ghStatus === 409 || err.ghStatus === 422) {
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 350 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(503, 'Too many people saving at once — please try again');
}

function githubHint(status, op) {
  if (status === 401) return 'GitHub rejected the token (401). Check GITHUB_TOKEN.';
  if (status === 403) return `GitHub refused the ${op} (403). The token needs Contents: read & write on this repo, or the rate limit was hit.`;
  if (status === 404) return `GitHub ${op} failed (404). Check GITHUB_OWNER, GITHUB_REPO and that the GITHUB_BRANCH branch exists.`;
  return `GitHub ${op} failed (${status})`;
}

/* ------------------------------------------------------------------ helpers */

function checkEnv(env) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'ADMIN_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new HttpError(500, `Worker not configured: missing ${missing.join(', ')}`);
}

function corsHeaders(env, origin) {
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Review-Code',
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
const isAdmin = (req, env) => safeEqual(req.headers.get('X-Admin-Key'), env.ADMIN_KEY);
function hasReviewCode(req, url, env) {
  if (!env.REVIEW_CODE) return true;
  return safeEqual(req.headers.get('X-Review-Code') || url.searchParams.get('code'), env.REVIEW_CODE);
}

async function readBody(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Body must be JSON'); }
}

function cleanText(value, max, label, optional = false) {
  const s = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!s && !optional) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
  return s;
}

function must(value, label) {
  if (!value) throw new HttpError(404, `${label} not found`);
  return value;
}

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
