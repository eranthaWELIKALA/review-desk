// Sign-in (Clerk tokens), site admins, members, invites, email and claiming old spaces.
//   cd worker && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { setup, user, token, ADMIN, approvedSpace, pngBody } from './helpers.mjs';

const tokenOf = (link) => link.split('#/invite/')[1];

test('session tokens: signature, issuer, origin, expiry and email are all checked', async () => {
  const { call, restore } = setup();
  const nimal = user('nimal');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  try {
    let r = await call('GET', '/api/me');
    assert.deepEqual(r.data, { signedIn: false });
    r = await call('GET', '/api/me', { as: nimal });
    assert.deepEqual([r.status, r.data.user.email], [200, 'nimal@example.com']);

    const bad = {
      'signed by another key': token(nimal, {}, other),
      'another issuer': token(nimal, { iss: 'https://evil.clerk.accounts.dev' }),
      'minted for another site': token(nimal, { azp: 'https://evil.example' }),
      expired: token(nimal, { exp: Math.floor(Date.now() / 1000) - 60 }),
      'not valid yet': token(nimal, { nbf: Math.floor(Date.now() / 1000) + 600 }),
      'pending session': token(nimal, { sts: 'pending' }),
      'alg none': `${Buffer.from('{"alg":"none"}').toString('base64url')}.${token(nimal).split('.')[1]}.x`,
      garbage: 'not-a-jwt',
    };
    for (const [why, t] of Object.entries(bad)) {
      r = await call('GET', '/api/me', { auth: `Bearer ${t}` });
      assert.equal(r.status, 401, why);
    }
    r = await call('GET', '/api/me', { auth: `Bearer ${token({ ...nimal, email: undefined, name: undefined }, { primaryEmail: 'Nimal@Example.com', fullName: 'Nimal P' })}` });
    assert.deepEqual([r.status, r.data.user.email, r.data.user.name], [200, 'nimal@example.com', 'Nimal P'], 'Clerk’s example claim names work too');
    r = await call('GET', '/api/me', { auth: `Bearer ${token({ ...nimal, email: '' })}` });
    assert.equal(r.status, 401);
    assert.match(r.data.error, /email claim/);
  } finally {
    restore();
  }
});

test('site admins: listed email and two-step verification', async () => {
  const { call, restore } = setup();
  try {
    let r = await call('GET', '/api/admin/overview', { as: user('nimal', { mfa: true }) });
    assert.equal(r.status, 403, 'not on the list');
    r = await call('GET', '/api/admin/overview', { as: { ...ADMIN, mfa: false } });
    assert.equal(r.status, 403, 'admin email without MFA');
    r = await call('GET', '/api/me', { as: { ...ADMIN, mfa: false } });
    assert.deepEqual([r.data.siteAdmin, r.data.adminNeedsMfa], [false, true]);
    r = await call('GET', '/api/admin/overview', { site: true });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/me', { site: true });
    assert.deepEqual([r.data.siteAdmin, r.data.adminNeedsMfa], [true, false]);
  } finally {
    restore();
  }
  const relaxed = setup({ ADMIN_REQUIRE_MFA: 'false' });
  try {
    const r = await relaxed.call('GET', '/api/admin/overview', { as: { ...ADMIN, mfa: false } });
    assert.equal(r.status, 200, 'ADMIN_REQUIRE_MFA=false drops the MFA rule');
  } finally {
    relaxed.restore();
  }
});

test('invites: owners invite editors by email; single use, bound to the address', async () => {
  const { call, restore } = setup();
  const owner = user('owner');
  const ed = user('ed');
  const realNow = Date.now;
  try {
    const { spaceId, reviewCode } = await approvedSpace(call, owner);
    const S = `/api/s/${spaceId}`;

    let r = await call('POST', `${S}/invites`, { as: owner, body: { email: 'Ed@Example.com', role: 'editor' } });
    assert.equal(r.status, 201);
    assert.deepEqual([r.data.kind, r.data.invite.email, r.data.invite.role, r.data.emailed], ['invite', 'ed@example.com', 'editor', false]);
    assert.match(r.data.emailNote, /copy the link/);
    assert.match(r.data.link, /^https:\/\/x\.github\.io\/review-desk\/#\/invite\/[A-Za-z0-9_-]{32}$/);
    const t = tokenOf(r.data.link);

    r = await call('GET', `/api/invites/${t}`);
    assert.deepEqual([r.data.title, r.data.role, r.data.status, r.data.email, r.data.inviter], ['Mango', 'editor', 'pending', 'ed*@example.com', 'Owner'], 'the address is masked');
    r = await call('GET', '/api/invites/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(r.status, 404);

    r = await call('POST', `/api/invites/${t}/accept`);
    assert.equal(r.status, 401, 'must sign in');
    r = await call('POST', `/api/invites/${t}/accept`, { as: user('mallory') });
    assert.equal(r.status, 403, 'another account can’t use a forwarded invite');
    assert.match(r.data.error, /ed\*@example\.com/);
    r = await call('POST', `/api/invites/${t}/accept`, { as: ed });
    assert.deepEqual([r.status, r.data.spaceId, r.data.role], [200, spaceId, 'editor']);
    r = await call('POST', `/api/invites/${t}/accept`, { as: ed });
    assert.equal(r.status, 410, 'single use');

    // Editors edit and invite reviewers, but not other editors.
    r = await call('GET', `${S}/me`, { as: ed });
    assert.deepEqual([r.data.admin, r.data.owner, r.data.role], [true, false, 'editor']);
    r = await call('POST', `${S}/sections`, { as: ed, body: { title: 'Home' } });
    assert.equal(r.status, 201);
    r = await call('POST', `${S}/sections/${r.data.id}/images`, { as: ed, body: pngBody() });
    assert.equal(r.status, 201);
    r = await call('POST', `${S}/invites`, { as: ed, body: { email: 'x@example.com', role: 'editor' } });
    assert.equal(r.status, 403);
    r = await call('POST', `${S}/invites`, { as: ed, body: { email: 'rev@example.com', role: 'reviewer' } });
    assert.equal(r.data.kind, 'review-link');
    assert.equal(r.data.link, `https://x.github.io/review-desk/?code=${reviewCode}#/${spaceId}`);

    r = await call('GET', `${S}/members`, { as: ed });
    assert.deepEqual(r.data.members.map((m) => [m.email, m.role]), [['owner@example.com', 'owner'], ['ed@example.com', 'editor']]);
    r = await call('GET', `${S}/members`, { code: reviewCode });
    assert.equal(r.status, 403, 'reviewers can’t list members');
    r = await call('POST', `${S}/invites`, { as: owner, body: { email: 'ed@example.com', role: 'editor' } });
    assert.equal(r.status, 409, 'already a member');

    // Revoking and expiry
    r = await call('POST', `${S}/invites`, { as: owner, body: { email: 'late@example.com', role: 'editor' } });
    const late = tokenOf(r.data.link);
    r = await call('POST', `${S}/invites`, { as: owner, body: { email: 'gone@example.com', role: 'editor' } });
    const gone = r.data;
    r = await call('DELETE', `${S}/invites/${gone.invite.id}`, { as: ed });
    assert.equal(r.status, 403, 'only owners revoke');
    r = await call('DELETE', `${S}/invites/${gone.invite.id}`, { as: owner });
    assert.deepEqual(r.data.invites.map((i) => i.email), ['late@example.com']);
    r = await call('POST', `/api/invites/${tokenOf(gone.link)}/accept`, { as: user('gone') });
    assert.equal(r.status, 410);
    Date.now = () => realNow() + 8 * 86400e3;
    r = await call('POST', `/api/invites/${late}/accept`, { as: user('late') });
    assert.equal(r.status, 410, 'invites expire after 7 days');
    r = await call('GET', `/api/invites/${late}`);
    assert.equal(r.data.status, 'expired');
  } finally {
    Date.now = realNow;
    restore();
  }
});

test('members: role changes, leaving, and a space always keeps an owner', async () => {
  const { call, restore } = setup();
  const owner = user('owner');
  const ed = user('ed');
  try {
    const { spaceId } = await approvedSpace(call, owner);
    const S = `/api/s/${spaceId}`;
    let r = await call('POST', `${S}/invites`, { as: owner, body: { email: ed.email, role: 'editor' } });
    await call('POST', `/api/invites/${tokenOf(r.data.link)}/accept`, { as: ed });

    r = await call('DELETE', `${S}/members/${owner.id}`, { as: owner });
    assert.equal(r.status, 409, 'the last owner can’t leave');
    r = await call('PATCH', `${S}/members/${owner.id}`, { as: owner, body: { role: 'editor' } });
    assert.equal(r.status, 409, 'or step down');
    r = await call('PATCH', `${S}/members/${ed.id}`, { as: ed, body: { role: 'owner' } });
    assert.equal(r.status, 403, 'editors can’t promote themselves');
    r = await call('PATCH', `${S}/members/${ed.id}`, { as: owner, body: { role: 'owner' } });
    assert.equal(r.status, 200);
    r = await call('DELETE', `${S}/members/${owner.id}`, { as: owner });
    assert.deepEqual(r.data.members.map((m) => [m.email, m.role]), [['ed@example.com', 'owner']], 'now the first owner can leave');
    r = await call('GET', `${S}/me`, { as: owner });
    assert.equal(r.data.admin, false);

    // Deleting the space removes its memberships.
    await call('DELETE', `/api/admin/spaces/${spaceId}`, { site: true });
    r = await call('GET', '/api/me', { as: ed });
    assert.deepEqual(r.data.spaces, []);
  } finally {
    restore();
  }
});

test('email: sent through Resend with escaped content, limits, and a fallback link', async () => {
  const { call, sent, env, restore } = setup({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'Review Desk <onboarding@resend.dev>', EMAIL_DAILY_LIMIT: '8' });
  const owner = user('owner', { name: 'Owner <script>' });
  try {
    const { spaceId } = await approvedSpace(call, owner, { title: 'Mango <img src=x onerror=alert(1)>' });
    assert.equal(sent.length, 1, 'approval emails the requester');
    assert.equal(sent[0].to[0], 'owner@example.com');
    assert.match(sent[0].subject, /is ready/);

    let r = await call('POST', `/api/s/${spaceId}/invites`, { as: owner, body: { email: 'ed@example.com', role: 'editor' } });
    assert.equal(r.data.emailed, true);
    const mail = sent.at(-1);
    assert.ok(mail.text.includes(r.data.link) && mail.html.includes(r.data.link));
    assert.ok(!mail.html.includes('<img src=x') && !mail.html.includes('<script>'), 'names and titles are escaped');
    assert.ok(mail.html.includes('&lt;img src=x'));
    assert.doesNotMatch(mail.subject, /[\r\n]/);

    // Per recipient: 5 a day, then a link to share instead.
    for (let i = 0; i < 4; i++) await call('POST', `/api/s/${spaceId}/invites`, { as: owner, body: { email: 'rev@example.com', role: 'reviewer' } });
    r = await call('POST', `/api/s/${spaceId}/invites`, { as: owner, body: { email: 'rev@example.com', role: 'reviewer' } });
    assert.equal(r.data.emailed, true, '5th is still sent');
    r = await call('POST', `/api/s/${spaceId}/invites`, { as: owner, body: { email: 'rev@example.com', role: 'reviewer' } });
    assert.deepEqual([r.data.emailed, !!r.data.link], [false, true]);
    // Daily total (8 here).
    r = await call('POST', `/api/s/${spaceId}/invites`, { as: owner, body: { email: 'z1@example.com', role: 'reviewer' } });
    r = await call('POST', `/api/s/${spaceId}/invites`, { as: owner, body: { email: 'z2@example.com', role: 'reviewer' } });
    assert.equal(r.data.emailed, false);
    assert.match(r.data.emailNote, /limit/);
    assert.equal(sent.length, 8);

    // Resend refusing (e.g. sandbox, unverified domain) still returns the link.
    env.EMAIL_DAILY_LIMIT = '100';
    env.RESEND_FAIL = true;
    r = await call('POST', `/api/s/${spaceId}/invites`, { as: owner, body: { email: 'z3@example.com', role: 'reviewer' } });
    assert.deepEqual([r.status, r.data.emailed, !!r.data.link], [201, false, true]);
  } finally {
    restore();
  }
});

test('old spaces: the key holder claims ownership once, then the key is retired', async () => {
  const { call, restore } = setup();
  const nimal = user('nimal');
  try {
    const { data } = await call('POST', '/api/admin/spaces', { site: true, body: { title: 'Old space' } });
    const id = data.spaceId;
    const { data: keys } = await call('GET', `/api/admin/spaces/${id}/keys`, { site: true });
    const S = `/api/s/${id}`;

    let r = await call('GET', `${S}/me`, { as: nimal, key: keys.adminKey });
    assert.equal(r.data.canClaim, true);
    r = await call('POST', `${S}/claim`, { as: nimal, key: 'sk-wrong' });
    assert.equal(r.status, 403);
    r = await call('POST', `${S}/claim`, { key: keys.adminKey });
    assert.equal(r.status, 401, 'claiming needs an account');
    r = await call('POST', `${S}/claim`, { as: nimal, key: keys.adminKey });
    assert.equal(r.status, 200);

    r = await call('GET', `${S}/me`, { as: nimal });
    assert.deepEqual([r.data.owner, r.data.role], [true, 'owner']);
    await new Promise((res) => setTimeout(res, 0));
    r = await call('GET', `${S}/me`, { key: keys.adminKey, ip: '9.9.9.1' });
    assert.equal(r.data.admin, false, 'the old key stops working');
  } finally {
    restore();
  }
  const strict = setup({ LEGACY_SPACE_KEYS: 'false' });
  try {
    const { data } = await strict.call('POST', '/api/admin/spaces', { site: true, body: { title: 'Old' } });
    const { data: keys } = await strict.call('GET', `/api/admin/spaces/${data.spaceId}/keys`, { site: true });
    let r = await strict.call('GET', `/api/s/${data.spaceId}/me`, { key: keys.adminKey });
    assert.equal(r.data.admin, false, 'LEGACY_SPACE_KEYS=false: keys no longer edit');
    r = await strict.call('POST', `/api/s/${data.spaceId}/claim`, { as: user('n'), key: keys.adminKey });
    assert.equal(r.status, 200, '…but can still be used to claim');
  } finally {
    strict.restore();
  }
});

test('admin creates a space for someone by email; demos stay key-only', async () => {
  const { call, restore } = setup();
  const kamal = user('kamal');
  try {
    let r = await call('POST', '/api/admin/spaces', { site: true, body: { title: 'Client X', email: 'kamal@example.com' } });
    assert.equal(r.status, 201);
    assert.equal(r.data.adminKey, undefined);
    assert.equal(r.data.invite.invite.role, 'owner');
    r = await call('POST', `/api/invites/${tokenOf(r.data.invite.link)}/accept`, { as: kamal });
    assert.equal(r.data.role, 'owner');
    r = await call('GET', '/api/me', { as: kamal });
    assert.deepEqual(r.data.spaces.map((s) => [s.title, s.role]), [['Client X', 'owner']]);

    const { data: demo } = await call('POST', '/api/demo');
    r = await call('POST', `/api/s/${demo.spaceId}/invites`, { as: kamal, key: demo.adminKey, body: { email: 'e@example.com', role: 'editor' } });
    assert.equal(r.status, 400, 'no editors in demos');
    r = await call('POST', `/api/s/${demo.spaceId}/invites`, { as: kamal, key: demo.adminKey, body: { email: 'e@example.com', role: 'reviewer' } });
    assert.deepEqual([r.status, r.data.emailed, !!r.data.link], [201, false, true], 'demos get the link but never send email');
    r = await call('POST', `/api/s/${demo.spaceId}/invites`, { key: demo.adminKey, body: { email: 'e@example.com', role: 'reviewer' } });
    assert.equal(r.status, 401, 'inviting needs an account, so emails say who sent them');
  } finally {
    restore();
  }
});
