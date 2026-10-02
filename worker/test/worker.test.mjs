// Core flows: requests, spaces, sections, screenshots, comments, demos, security.
//   cd worker && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker.js';
import { setup, user, PNG, pngBody } from './helpers.mjs';

test('request → approve → owner account → review flow', async () => {
  const { gh, call, sent, restore } = setup();
  const nimal = user('nimal');
  try {
    // Requests need an account; name and email come from it.
    let r = await call('POST', '/api/requests', { body: { organization: 'Mango', purpose: 'Sprint reviews' } });
    assert.equal(r.status, 401);
    r = await call('POST', '/api/requests', { as: nimal, body: { organization: 'Mango', purpose: 'Sprint reviews' } });
    assert.equal(r.status, 201);
    const rid = r.data.id;
    r = await call('GET', '/api/me', { as: nimal });
    assert.deepEqual(r.data.requests.map((x) => [x.id, x.status]), [[rid, 'pending']]);

    // Only the site admin sees and decides requests; IP hashes never leave the Worker.
    r = await call('GET', '/api/admin/overview', { as: nimal });
    assert.equal(r.status, 403);
    r = await call('GET', '/api/admin/overview', { site: true });
    assert.equal(r.data.requests[0].email, 'nimal@example.com');
    assert.equal(r.data.requests[0].ipHash, undefined);

    r = await call('POST', `/api/admin/requests/${rid}/approve`, { site: true, body: { quotaMb: 1 } });
    assert.equal(r.status, 201);
    const { spaceId, reviewCode } = r.data;
    assert.match(spaceId, /^s[a-z0-9]+$/);
    assert.equal(r.data.adminKey, undefined, 'no space key for account-owned spaces');
    assert.equal(r.data.owner, 'nimal@example.com');
    assert.equal(r.data.emailed, false, 'email is off without RESEND_API_KEY');
    assert.match(reviewCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, '12-character review codes');
    assert.equal(r.data.space.title, 'Mango');
    r = await call('POST', `/api/admin/requests/${rid}/approve`, { site: true, body: {} });
    assert.equal(r.status, 409, 'cannot approve twice');
    assert.equal(sent.length, 0);

    // The requester is now the owner.
    r = await call('GET', '/api/me', { as: nimal });
    assert.deepEqual(r.data.spaces, [{ id: spaceId, title: 'Mango', role: 'owner' }]);
    assert.equal(r.data.requests[0].status, 'approved');
    const { data: keys } = await call('GET', `/api/admin/spaces/${spaceId}/keys`, { site: true });
    const adminKey = keys.adminKey; // still exists for spaces made before accounts

    // No secrets are written to the repo.
    const repoText = Object.values(gh.files()).map(String).join('\n');
    assert.ok(!repoText.includes(adminKey) && !repoText.includes(reviewCode.replaceAll('-', '')));

    // Access levels
    const S = `/api/s/${spaceId}`;
    r = await call('GET', `${S}/me`);
    assert.deepEqual([r.data.authorized, r.data.admin, r.data.space.title], [false, false, undefined]);
    r = await call('GET', `${S}/project`, { code: 'WRONG-CODE' });
    assert.equal(r.status, 401);
    r = await call('GET', `${S}/me`, { code: reviewCode.toLowerCase().replaceAll('-', ' ') });
    assert.deepEqual([r.data.authorized, r.data.admin, r.data.reviewCode], [true, false, null], 'codes are case and dash insensitive');
    const imageToken = r.data.imageToken;
    assert.match(imageToken, /^[a-z0-9]+\.[A-Za-z0-9_-]{32}$/);
    r = await call('GET', `${S}/me`, { as: nimal });
    assert.deepEqual([r.data.authorized, r.data.admin, r.data.owner, r.data.role, r.data.reviewCode], [true, true, true, 'owner', reviewCode]);
    r = await call('GET', `${S}/me`, { as: user('stranger') });
    assert.deepEqual([r.data.authorized, r.data.admin], [false, false], 'an account alone gives no access');
    r = await call('GET', `${S}/me`, { key: adminKey });
    assert.equal(r.data.admin, true, 'legacy space keys still work while LEGACY_SPACE_KEYS is on');
    r = await call('GET', `${S}/me`, { key: adminKey.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) });
    assert.equal(r.data.admin, false);
    r = await call('GET', '/api/s/szzzzzzzzzzzzz/me');
    assert.equal(r.status, 404);

    r = await call('POST', `${S}/sections`, { code: reviewCode, body: { title: 'Rider onboarding' } });
    assert.equal(r.status, 403, 'reviewers cannot create sections');
    r = await call('POST', `${S}/sections`, { as: nimal, body: { title: 'Rider onboarding', description: 'Sign-up screens' } });
    assert.equal(r.status, 201);
    const sid = r.data.id;

    r = await call('POST', `${S}/sections/${sid}/images`, { as: nimal, body: pngBody('Login Screen.PNG', { caption: 'v2' }) });
    assert.equal(r.status, 201);
    const img = r.data.images[0];
    assert.match(img.path, new RegExp(`^${sid}/[a-z0-9]+-login-screen\\.png$`));
    assert.equal(img.bytes, PNG.length);
    assert.ok(gh.files()[`spaces/${spaceId}/images/${img.path}`]);
    r = await call('POST', `${S}/sections/${sid}/images`, { as: nimal, body: { filename: 'x.exe', data: 'AAAA' } });
    assert.equal(r.status, 400);

    r = await call('GET', `${S}/project`, { code: reviewCode });
    assert.equal(r.data.space.usedBytes, PNG.length);
    assert.equal(r.data.space.quotaBytes, 1024 * 1024);

    // Images are served through the Worker with a short-lived token, never the review code.
    r = await call('GET', `/img/${spaceId}/${img.path}?t=${imageToken}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(Buffer.from(r.data), PNG);
    r = await call('GET', `/img/${spaceId}/${img.path}`);
    assert.equal(r.status, 401);
    r = await call('GET', `/img/${spaceId}/${img.path}?code=${reviewCode}`);
    assert.equal(r.status, 401, 'review codes are not accepted in URLs');
    r = await call('GET', `/img/${spaceId}/${img.path}?t=${imageToken.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}`);
    assert.equal(r.status, 401);
    r = await call('GET', `/img/${spaceId}/%2E%2E%2Findex.json?t=${imageToken}`);
    assert.equal(r.status, 400);

    // Comments: pinned on image, on section, reply, unicode. Account comments use the account name.
    r = await call('POST', `${S}/sections/${sid}/comments`, { code: reviewCode, body: { author: 'Nimal', text: 'Button too small', target: img.id, pin: { x: 140, y: 33.333 } } });
    assert.equal(r.status, 201);
    const c1 = r.data.comments[0];
    assert.deepEqual(c1.pin, { x: 100, y: 33.33 });
    r = await call('POST', `${S}/sections/${sid}/comments`, { code: reviewCode, body: { author: 'කමල්', text: 'Flow looks good 👍', target: 'section' } });
    assert.equal(r.data.comments[1].text, 'Flow looks good 👍');
    r = await call('POST', `${S}/sections/${sid}/comments`, { as: nimal, body: { author: 'Erantha', text: 'Will fix', parentId: c1.id, target: 'section' } });
    assert.equal(r.data.comments[2].target, img.id, 'reply inherits the parent target');
    assert.deepEqual([r.data.comments[2].author, r.data.comments[2].verified], ['Nimal', true], 'signed-in authors can’t be impersonated');
    assert.equal(r.data.comments[0].verified, undefined);
    r = await call('POST', `${S}/sections/${sid}/comments`, { code: reviewCode, body: { author: '', text: 'x' } });
    assert.equal(r.status, 400);

    // Concurrency: 8 comments at once all land
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      call('POST', `${S}/sections/${sid}/comments`, { code: reviewCode, body: { author: `P${i}`, text: `c${i}`, target: 'section' } })));
    r = await call('GET', `${S}/project`, { code: reviewCode });
    assert.equal(r.data.sections[0].comments.length, 11);

    r = await call('PATCH', `${S}/sections/${sid}/comments/${c1.id}`, { code: reviewCode, body: { resolved: true } });
    assert.equal(r.status, 403);
    r = await call('PATCH', `${S}/sections/${sid}/comments/${c1.id}`, { as: nimal, body: { resolved: true } });
    assert.equal(r.data.comments.find((c) => c.id === c1.id).resolved, true);
    r = await call('DELETE', `${S}/sections/${sid}/comments/${c1.id}`, { as: nimal });
    assert.equal(r.data.comments.length, 9, 'comment and its reply removed');

    // Rotating the review code locks out the old one.
    r = await call('POST', `${S}/rotate-code`, { as: nimal });
    const newCode = r.data.reviewCode;
    assert.notEqual(newCode, reviewCode);
    r = await call('GET', `${S}/project`, { code: reviewCode });
    assert.equal(r.status, 401);
    r = await call('GET', `${S}/project`, { code: newCode });
    assert.equal(r.status, 200);
    r = await call('GET', `/img/${spaceId}/${img.path}?t=${imageToken}`);
    assert.equal(r.status, 401, 'a new review code also cuts off old image links');

    // Deleting a screenshot frees its storage; deleting a section removes its files.
    r = await call('DELETE', `${S}/sections/${sid}/images/${img.id}`, { as: nimal });
    assert.equal(r.data.images.length, 0);
    r = await call('POST', `${S}/sections/${sid}/images`, { as: nimal, body: pngBody('again.png') });
    r = await call('DELETE', `${S}/sections/${sid}`, { as: nimal });
    assert.equal(r.status, 200);
    r = await call('GET', `${S}/project`, { as: nimal });
    assert.deepEqual([r.data.sections.length, r.data.space.usedBytes], [0, 0]);
    assert.deepEqual(Object.keys(gh.files()).filter((p) => p.startsWith(`spaces/${spaceId}/`)), [`spaces/${spaceId}/index.json`]);

    // Space owners can't delete an approved space; the site admin can.
    r = await call('DELETE', S, { as: nimal });
    assert.equal(r.status, 403);
    r = await call('POST', `/api/admin/spaces/${spaceId}/rotate-key`, { site: true });
    assert.notEqual(r.data.adminKey, adminKey);
    r = await call('GET', `/api/admin/audit?space=${spaceId}`, { site: true });
    assert.ok(['request.approve', 'space.view_keys', 'space.rotate_key'].every((a) => r.data.entries.some((e) => e.action === a)), 'admin actions are audited');
    r = await call('DELETE', `/api/admin/spaces/${spaceId}`, { site: true });
    assert.equal(r.status, 200);
    r = await call('GET', `${S}/me`, { site: true });
    assert.equal(r.status, 404);
    r = await call('GET', '/api/admin/overview', { site: true });
    assert.deepEqual(r.data.spaces, []);

    // The request record (personal data) can be purged.
    r = await call('DELETE', `/api/admin/requests/${rid}`, { site: true });
    assert.equal(r.status, 200);
    assert.ok(!String(gh.files()['registry/requests.json']).includes('nimal@example.com'));

    r = await call('OPTIONS', '/api/config');
    assert.equal(r.status, 204);
    assert.match(r.headers.get('Access-Control-Allow-Headers'), /X-Space-Key/);
  } finally {
    restore();
  }
});

test('requests can be rejected and are rate limited', async () => {
  const { call, restore } = setup();
  const a = user('a');
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/api/requests', { as: a, ip: `3.3.3.${i}`, body: { purpose: 'p' } });
      assert.equal(r.status, 201);
      ids.push(r.data);
    }
    let r = await call('POST', '/api/requests', { as: a, ip: '3.3.3.9', body: { purpose: 'p' } });
    assert.equal(r.status, 429, 'max 3 pending per account');
    r = await call('POST', '/api/requests', { as: user('b'), ip: '2.2.2.2', body: { purpose: 'p' } });
    assert.equal(r.status, 201);

    r = await call('POST', `/api/admin/requests/${ids[0].id}/reject`, { site: true, body: { reason: 'Not a fit' } });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/me', { as: a });
    const mine = r.data.requests.find((x) => x.id === ids[0].id);
    assert.deepEqual([mine.status, mine.reason], ['rejected', 'Not a fit']);
    r = await call('POST', `/api/admin/requests/${ids[0].id}/approve`, { site: true, body: {} });
    assert.equal(r.status, 409);
  } finally {
    restore();
  }
});

test('demo spaces: quota, limits, expiry and cleanup', async () => {
  const { gh, call, restore } = setup({ DEMO_PER_IP_PER_DAY: '2', DEMO_MAX_ACTIVE: '3' });
  const realNow = Date.now;
  try {
    let r = await call('GET', '/api/config');
    assert.deepEqual([r.data.demo.enabled, r.data.demo.hours], [true, 24]);

    r = await call('POST', '/api/demo');
    assert.equal(r.status, 201);
    const demo = r.data;
    assert.match(demo.spaceId, /^d[a-z0-9]+$/);
    assert.equal(demo.space.kind, 'demo');
    assert.ok(Date.parse(demo.space.expiresAt) - realNow() > 23.9 * 3600e3);
    assert.ok(gh.files('demo-data'), 'demo branch is created on first use');
    assert.ok(!gh.files()[`spaces/${demo.spaceId}/index.json`], 'demo data stays off the main branch');

    // Quota (≈1 KB in this test): first image fits, then the space is full.
    const S = `/api/s/${demo.spaceId}`;
    r = await call('POST', `${S}/sections`, { key: demo.adminKey, body: { title: 'Try' } });
    const sid = r.data.id;
    r = await call('POST', `${S}/sections/${sid}/images`, { key: demo.adminKey, body: pngBody('a.png') });
    assert.equal(r.status, 201);
    for (let i = 0; i < 20 && r.status === 201; i++) r = await call('POST', `${S}/sections/${sid}/images`, { key: demo.adminKey, body: pngBody(`b${i}.png`) });
    assert.equal(r.status, 413);
    assert.match(r.data.error, /Not enough storage/);
    r = await call('GET', `${S}/project`, { key: demo.adminKey });
    const used = r.data.space.usedBytes;
    assert.ok(used <= r.data.space.quotaBytes);
    assert.equal(used, r.data.sections[0].images.reduce((n, i) => n + i.bytes, 0), 'failed uploads are refunded');

    // Per-visitor and global limits
    r = await call('POST', '/api/demo');
    assert.equal(r.status, 201);
    r = await call('POST', '/api/demo');
    assert.equal(r.status, 429);
    r = await call('POST', '/api/demo', { ip: '9.9.9.9' });
    assert.equal(r.status, 201);
    r = await call('POST', '/api/demo', { ip: '8.8.8.8' });
    assert.equal(r.status, 429, 'all demo slots in use');

    r = await call('GET', '/api/admin/overview', { site: true });
    assert.equal(r.data.demos.length, 3);

    // Cleanup does nothing while demos are fresh.
    r = await call('POST', '/api/admin/cleanup', { site: true });
    assert.equal(r.data.removedSpaces, 0);

    // 25 hours later: the demo is gone, even before cleanup runs…
    Date.now = () => realNow() + 25 * 3600e3;
    r = await call('GET', `${S}/me`, { key: demo.adminKey });
    assert.equal(r.status, 410);
    assert.ok(gh.history('demo-data') > 1);

    // …and cleanup deletes the files and the branch history.
    r = await call('POST', '/api/admin/cleanup', { site: true });
    assert.equal(r.data.removedSpaces, 3);
    const files = gh.files('demo-data');
    assert.deepEqual(Object.keys(files), ['registry/demos.json']);
    assert.deepEqual(JSON.parse(files['registry/demos.json']).demos, []);
    assert.equal(gh.history('demo-data'), 1, 'demo history is dropped');

    // Slots are free again.
    r = await call('POST', '/api/demo', { ip: '8.8.8.8' });
    assert.equal(r.status, 201);
  } finally {
    Date.now = realNow;
    restore();
  }
});

test('demo owners can delete their demo early', async () => {
  const { gh, call, restore } = setup();
  try {
    const { data: demo } = await call('POST', '/api/demo');
    let r = await call('DELETE', `/api/s/${demo.spaceId}`, { code: demo.reviewCode });
    assert.equal(r.status, 403, 'reviewers cannot delete');
    r = await call('DELETE', `/api/s/${demo.spaceId}`, { key: demo.adminKey });
    assert.equal(r.status, 200);
    assert.ok(!Object.keys(gh.files('demo-data')).some((p) => p.startsWith('spaces/')));
  } finally {
    restore();
  }
});

test('site admin can create spaces directly and change quota', async () => {
  const { call, restore } = setup();
  try {
    let r = await call('POST', '/api/admin/spaces', { site: true, body: { title: 'Internal', quotaMb: 50 } });
    assert.equal(r.status, 201);
    const id = r.data.spaceId;
    r = await call('PATCH', `/api/admin/spaces/${id}`, { site: true, body: { quotaMb: 75 } });
    assert.equal(r.data.quotaBytes, 75 * 1024 * 1024);
    r = await call('PATCH', `/api/admin/spaces/${id}`, { site: true, body: { quotaMb: 0 } });
    assert.equal(r.status, 400);
    r = await call('GET', `/api/admin/spaces/${id}/keys`, { site: true });
    assert.match(r.data.adminKey, /^sk-/);
    r = await call('GET', `/api/s/${id}/me`, { site: true });
    assert.equal(r.data.admin, true, 'site admin is admin in every space');
  } finally {
    restore();
  }
});

test('missing configuration is logged, not shown to clients', async () => {
  const logged = [];
  const realError = console.error;
  console.error = (m) => logged.push(m);
  try {
    const res = await worker.fetch(new Request('https://w.dev/api/config'), {});
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.doesNotMatch(body.error, /GITHUB|SECRET|ADMIN/);
    assert.match(body.error, new RegExp(`Reference: ${body.requestId}`));
    assert.equal(res.headers.get('X-Request-Id'), body.requestId);
    assert.match(logged.join('\n'), /missing GITHUB_TOKEN.*SPACE_SECRET/);
  } finally {
    console.error = realError;
  }
});

/* ------------------------------------------------------------- security */

test('wrong credentials are rate limited per IP, even when a later guess is right', async () => {
  const { call, restore } = setup({ RATE_AUTH_PER_MIN: '5' });
  try {
    const { data: demo } = await call('POST', '/api/demo');
    const S = `/api/s/${demo.spaceId}`;
    for (let i = 0; i < 5; i++) assert.equal((await call('GET', `${S}/project`, { code: `WRONGCODE${i}`, ip: '7.7.7.7' })).status, 401);
    let r = await call('GET', `${S}/project`, { code: demo.reviewCode, ip: '7.7.7.7' });
    assert.equal(r.status, 429, 'locked out: a correct guess is refused too');
    assert.equal(r.headers.get('Retry-After'), '60');
    r = await call('GET', `${S}/project`, { code: demo.reviewCode, ip: '6.6.6.6' });
    assert.equal(r.status, 200, 'other visitors are unaffected');
    for (let i = 0; i < 10; i++) r = await call('GET', `${S}/project`, { code: demo.reviewCode, ip: '6.6.6.6' });
    assert.equal(r.status, 200, 'a known-good code does not use up the limit');
  } finally {
    restore();
  }
});

test('writes are rate limited per IP', async () => {
  const { call, restore } = setup({ RATE_WRITES_PER_MIN: '4' });
  try {
    const { data: demo } = await call('POST', '/api/demo', { ip: '4.4.4.4' });
    const S = `/api/s/${demo.spaceId}`;
    const { data: sec } = await call('POST', `${S}/sections`, { key: demo.adminKey, ip: '4.4.4.4', body: { title: 'T' } });
    let r;
    for (let i = 0; i < 3; i++) r = await call('POST', `${S}/sections/${sec.id}/comments`, { code: demo.reviewCode, ip: '4.4.4.4', body: { author: 'A', text: 'x' } });
    assert.equal(r.status, 429);
  } finally {
    restore();
  }
});

test('input validation: magic bytes, control characters, body size, JSON shape', async () => {
  const { gh, call, restore } = setup();
  try {
    const { data: demo } = await call('POST', '/api/demo');
    const S = `/api/s/${demo.spaceId}`;
    const { data: sec } = await call('POST', `${S}/sections`, { key: demo.adminKey, body: { title: 'Line one\nGit-Trailer: x' } });
    assert.equal(sec.title, 'Line one Git-Trailer: x', 'single-line fields lose line breaks');
    const html = Buffer.from('<script>alert(1)</script>').toString('base64');
    let r = await call('POST', `${S}/sections/${sec.id}/images`, { key: demo.adminKey, body: { filename: 'evil.png', data: html } });
    assert.equal(r.status, 400, 'a non-image with a .png name is refused');
    assert.match(r.data.error, /valid PNG/);
    r = await call('POST', `${S}/sections/${sec.id}/comments`, { code: demo.reviewCode, body: { author: 'Eve\n\nSigned-off-by: x', text: 'line 1\nline 2\u0007' } });
    const c = r.data.comments[0];
    assert.deepEqual([c.author, c.text], ['Eve Signed-off-by: x', 'line 1\nline 2']);
    assert.ok(!gh.log('demo-data').some((m) => m.includes('\n')), 'commit messages stay on one line');

    // Body cap is enforced while streaming, not just from Content-Length.
    const big = new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode(`{"author":"A","text":"${'x'.repeat(70 * 1024)}"}`)); ctl.close(); } });
    r = await call('POST', `${S}/sections/${sec.id}/comments`, { code: demo.reviewCode, body: big });
    assert.equal(r.status, 413);
    r = await call('POST', `${S}/sections/${sec.id}/comments`, { code: demo.reviewCode, body: '[1,2]' });
    assert.equal(r.status, 400);
  } finally {
    restore();
  }
});

test('CORS is denied unless the origin is listed; security headers everywhere', async () => {
  const { call, env, restore } = setup();
  try {
    let r = await call('GET', '/api/config');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://x.github.io');
    for (const h of ['X-Content-Type-Options', 'Referrer-Policy', 'Content-Security-Policy', 'Strict-Transport-Security']) assert.ok(r.headers.get(h), h);
    r = await call('GET', '/api/config', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
    delete env.ALLOWED_ORIGINS;
    r = await call('GET', '/api/config');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, 'unset means deny, not *');
  } finally {
    restore();
  }
});

test('spaces created before 12-character codes keep working until rotated', async () => {
  const { call, restore } = setup();
  try {
    const { data } = await call('POST', '/api/admin/spaces', { site: true, body: { title: 'Old' } });
    const id = data.spaceId;
    // Turn it back into a pre-upgrade space (no codeScheme) through the fake GitHub API.
    const url = `https://api.github.com/repos/o/r/contents/spaces/${id}/index.json`;
    const meta = await (await fetch(`${url}?ref=review-data`)).json();
    const idx = JSON.parse(Buffer.from(meta.content, 'base64').toString());
    delete idx.codeScheme;
    await fetch(url, { method: 'PUT', body: JSON.stringify({ message: 'downgrade', branch: 'review-data', sha: meta.sha, content: Buffer.from(JSON.stringify(idx)).toString('base64') }) });
    await new Promise((r) => setTimeout(r, 0));

    const mac = createHmac('sha256', 'space-secret').update(`code:${id}:1`).digest();
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const legacy = Array.from(mac.subarray(0, 8), (b) => alphabet[b % alphabet.length]).join('');
    // The auth cache may still hold the new-style index for 30 s; ask with a fresh id read.
    const r0 = await call('GET', `/api/admin/spaces/${id}/keys`, { site: true });
    assert.match(r0.data.reviewCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'old spaces report their 8-character code');
    assert.equal(r0.data.reviewCode.replace('-', ''), legacy);

    let r = await call('POST', `/api/s/${id}/rotate-code`, { site: true });
    assert.match(r.data.reviewCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'rotating upgrades to 12 characters');
    r = await call('GET', `/api/s/${id}/project`, { code: r.data.reviewCode });
    assert.equal(r.status, 200);
  } finally {
    restore();
  }
});
