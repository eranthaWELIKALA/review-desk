// Runs the Worker against an in-memory fake of the GitHub Contents API.
//   node --test worker/test
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

function fakeGitHub() {
  const files = new Map(); // path -> { sha, b64 }
  let n = 0;
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/repos\/o\/r\/contents\/(.+)$/);
    if (!m) return new Response('nope', { status: 404 });
    const path = m[1].split('/').map(decodeURIComponent).join('/');
    const method = init.method || 'GET';
    calls.push(`${method} ${path}`);
    const accept = init.headers?.Accept || '';
    if (method === 'GET') {
      const f = files.get(path);
      if (!f) return new Response('{}', { status: 404 });
      if (accept.includes('raw')) return new Response(Buffer.from(f.b64, 'base64'));
      return Response.json({ sha: f.sha, encoding: 'base64', content: f.b64.replace(/(.{60})/g, '$1\n') });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.branch, 'review-data');
    const f = files.get(path);
    if (method === 'PUT') {
      if (f && body.sha !== f.sha) return new Response('{}', { status: 409 });
      if (!f && body.sha) return new Response('{}', { status: 422 });
      files.set(path, { sha: `s${++n}`, b64: body.content });
      return Response.json({ content: { sha: `s${n}` } });
    }
    if (method === 'DELETE') {
      if (!f || body.sha !== f.sha) return new Response('{}', { status: 409 });
      files.delete(path);
      return Response.json({});
    }
  };
  return { files, calls, restore: () => { globalThis.fetch = realFetch; } };
}

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'review-data',
  ADMIN_KEY: 'admin-secret', REVIEW_CODE: 'mango', ALLOWED_ORIGINS: 'https://x.github.io', PUBLIC_IMAGES: 'false',
};

async function call(method, path, { body, admin, code = 'mango' } = {}) {
  const headers = { Origin: 'https://x.github.io', 'Content-Type': 'application/json' };
  if (admin) headers['X-Admin-Key'] = 'admin-secret';
  if (code) headers['X-Review-Code'] = code;
  const res = await worker.fetch(new Request(`https://w.dev${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), env);
  const type = res.headers.get('Content-Type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('full review flow', async () => {
  const gh = fakeGitHub();
  try {
    let r = await call('GET', '/api/me', { code: null });
    assert.deepEqual([r.data.authorized, r.data.codeRequired, r.data.admin], [false, true, false]);

    r = await call('GET', '/api/project', { code: 'wrong' });
    assert.equal(r.status, 401);

    r = await call('GET', '/api/project');
    assert.deepEqual(r.data, { title: 'Design Review', sections: [] });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://x.github.io');

    r = await call('POST', '/api/sections', { body: { title: 'Rider onboarding' } });
    assert.equal(r.status, 403, 'clients cannot create sections');

    r = await call('POST', '/api/sections', { admin: true, body: { title: 'Rider onboarding', description: 'Sign-up screens' } });
    assert.equal(r.status, 201);
    const sid = r.data.id;

    r = await call('POST', `/api/sections/${sid}/images`, {
      admin: true, body: { filename: 'Login Screen.PNG', data: 'data:image/png;base64,' + PNG.toString('base64'), caption: 'v2' },
    });
    assert.equal(r.status, 201);
    const img = r.data.images[0];
    assert.match(img.path, new RegExp(`^images/${sid}/[a-z0-9]+-login-screen\\.png$`));
    assert.ok(gh.files.has(img.path));

    r = await call('POST', `/api/sections/${sid}/images`, { admin: true, body: { filename: 'x.exe', data: 'AAAA' } });
    assert.equal(r.status, 400);

    // Image is served back through the worker
    r = await call('GET', `/img/${img.path}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(Buffer.from(r.data), PNG);
    r = await call('GET', `/img/${img.path}`, { code: null });
    assert.equal(r.status, 401);
    r = await call('GET', `/img/images/../data/index.json`);
    assert.equal(r.status, 400);

    // Client comments: pinned on image, on section, reply, unicode
    r = await call('POST', `/api/sections/${sid}/comments`, { body: { author: 'Nimal', text: 'Button too small', target: img.id, pin: { x: 140, y: 33.333 } } });
    assert.equal(r.status, 201);
    const c1 = r.data.comments[0];
    assert.deepEqual(c1.pin, { x: 100, y: 33.33 });

    r = await call('POST', `/api/sections/${sid}/comments`, { body: { author: 'කමල්', text: 'Flow looks good 👍', target: 'section' } });
    assert.equal(r.data.comments[1].text, 'Flow looks good 👍');
    assert.equal(r.data.comments[1].author, 'කමල්');

    r = await call('POST', `/api/sections/${sid}/comments`, { body: { author: 'Erantha', text: 'Will fix', parentId: c1.id, target: 'section' } });
    assert.equal(r.data.comments[2].target, img.id, 'reply inherits the parent target');
    assert.equal(r.data.comments[2].pin, null);

    r = await call('POST', `/api/sections/${sid}/comments`, { body: { author: '', text: 'x' } });
    assert.equal(r.status, 400);
    r = await call('POST', `/api/sections/${sid}/comments`, { body: { author: 'A', text: 'x', target: 'nope' } });
    assert.equal(r.status, 404);

    // Concurrency: 8 comments at once all land
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      call('POST', `/api/sections/${sid}/comments`, { body: { author: `P${i}`, text: `c${i}`, target: 'section' } })));
    r = await call('GET', '/api/project');
    assert.equal(r.data.sections[0].comments.length, 11);

    // Admin resolves and deletes
    r = await call('PATCH', `/api/sections/${sid}/comments/${c1.id}`, { body: { resolved: true } });
    assert.equal(r.status, 403);
    r = await call('PATCH', `/api/sections/${sid}/comments/${c1.id}`, { admin: true, body: { resolved: true } });
    assert.equal(r.data.comments.find((c) => c.id === c1.id).resolved, true);
    r = await call('DELETE', `/api/sections/${sid}/comments/${c1.id}`, { admin: true });
    assert.equal(r.data.comments.length, 9, 'comment and its reply removed');

    r = await call('PATCH', '/api/project', { admin: true, body: { title: 'Mango — Sprint 12' } });
    assert.equal(r.data.title, 'Mango — Sprint 12');

    // Deleting the image removes its file
    r = await call('DELETE', `/api/sections/${sid}/images/${img.id}`, { admin: true });
    assert.equal(r.data.images.length, 0);
    assert.ok(!gh.files.has(img.path));

    r = await call('DELETE', `/api/sections/${sid}`, { admin: true });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/project');
    assert.deepEqual(r.data.sections, []);
    assert.deepEqual([...gh.files.keys()], ['data/index.json']);

    r = await call('OPTIONS', '/api/project');
    assert.equal(r.status, 204);
  } finally {
    gh.restore();
  }
});

test('reports missing configuration clearly', async () => {
  const res = await worker.fetch(new Request('https://w.dev/api/me'), {});
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /missing GITHUB_TOKEN/);
});
