/* Review Desk — static front end for GitHub Pages.
 * All reads/writes go through the Worker in config.js; nothing secret lives here.
 *
 * Sign-in is Clerk (config.js: clerkPublishableKey). Each API call carries a fresh,
 * short-lived Clerk session token; the Worker decides what that account may do.
 *
 * Routes (hash):
 *   #/                     home: your spaces, try a demo, request a space
 *   #/admin                site admin console
 *   #/invite[/<token>]     accept an invite to own or edit a space
 *   #/r/<id>[/<token>]     status of a space request made before accounts
 *   #/<space>[/s/<sid>[/i/<iid>]]   a space, a section, a screenshot */
(() => {
  'use strict';

  const API = String((window.REVIEW_CONFIG || {}).apiUrl || '').replace(/\/+$/, '');
  const MAX_UPLOAD = 15 * 1024 * 1024;
  const SPACE_RE = /^[sd][a-z0-9]{10,30}$/;
  const KEY_RE = /^sk-([sd][a-z0-9]{10,30})-[A-Za-z0-9_-]{22}$/;
  const SITE = location.origin + location.pathname;

  /* ---------------------------------------------------------------- storage */
  const store = {
    get(k) { try { return localStorage.getItem('rd:' + k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('rd:' + k) : localStorage.setItem('rd:' + k, v); } catch { /* private mode */ } },
    json(k) { try { return JSON.parse(this.get(k)) || null; } catch { return null; } },
    setJson(k, v) { this.set(k, v == null ? null : JSON.stringify(v)); },
  };

  // Tab-only storage: an invite token waiting for sign-in to finish.
  const session = {
    get(k) { try { return sessionStorage.getItem('rd:' + k); } catch { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem('rd:' + k) : sessionStorage.setItem('rd:' + k, v); } catch { /* private mode */ } },
  };
  // Purge admin credentials that older versions kept; admins sign in with an account now.
  store.set('siteKey', null);
  session.set('siteKey', null);
  session.set('siteSession', null);

  // Keys and review codes per space, remembered on this device only.
  const creds = {
    all() { return store.json('spaces') || {}; },
    get(id) { return (id && this.all()[id]) || {}; },
    set(id, patch) {
      const all = this.all();
      all[id] = { ...all[id], ...patch, seen: Date.now() };
      for (const k of Object.keys(all[id])) if (all[id][k] == null) delete all[id][k];
      store.setJson('spaces', all);
    },
    forget(id) { const all = this.all(); delete all[id]; store.setJson('spaces', all); },
  };
  const myRequests = () => store.json('requests') || [];
  const saveRequests = (list) => store.setJson('requests', list);

  /* ------------------------------------------------------------------ state */
  const state = {
    route: { view: 'home' },
    config: null,
    me: null,
    project: null,
    account: null,       // GET /api/me: { signedIn, user, spaces, requests, siteAdmin, … }
    invite: null,        // invite preview on #/invite
    shareTab: 'reviewers',
    members: null,       // GET /api/s/<id>/members, for the Team tab
    audit: null,         // admin Activity tab
    overview: null,
    usage: {},           // space id -> admin info (usage), loaded lazily
    adminTab: 'requests',
    request: null,       // status shown on #/r/<id>
    name: store.get('name') || '',
    drafts: {},          // composer text, keyed by draft id
    replyTo: null,       // comment id currently being replied to
    pinDraft: null,      // { x, y } on the open screenshot
    showResolved: {},    // target id -> bool
    highlight: null,     // comment id hovered
    menuOpen: false,
    welcome: null,       // demo id that was just created
    lastLoad: 0,
    busy: false,
  };

  /* ------------------------------------------------------------------- icons */
  const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><rect x="3" y="5" width="15" height="12"/><circle cx="18" cy="17" r="3.4" fill="currentColor" stroke="none"/></svg>',
    upload: svg('<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    left: svg('<path d="M15 6l-6 6 6 6"/>'),
    right: svg('<path d="M9 6l6 6-6 6"/>'),
    chat: svg('<path d="M4 5h16v11H9l-5 4z"/>', 2.2),
    pin: svg('<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>'),
    link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    share: svg('<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/>'),
    dots: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', 2.4),
    spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
    box: svg('<path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10"/>'),
    key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    check: svg('<path d="M5 12l5 5L20 7"/>', 2.4),
    user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
    shield: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 2.4),
  };

  /* ---------------------------------------------------------------- helpers */
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAdmin = () => !!state.me?.admin;
  const coarse = matchMedia('(pointer: coarse)').matches;

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function ago(iso) {
    const s = (new Date(iso) - Date.now()) / 1000;
    const steps = [[60, 'second'], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400]];
    if (Math.abs(s) < 45) return 'just now';
    for (const [lim, unit, div = 1] of steps) if (Math.abs(s) < lim) return rtf.format(Math.round(s / div), unit);
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function timeLeft(iso) {
    const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
    return m >= 90 ? `${Math.round(m / 60)} h` : `${m} min`;
  }
  function fmtBytes(b) {
    b = b || 0;
    if (b < 1024 * 1024) return `${Math.max(b ? 1 : 0, Math.round(b / 1024))} KB`;
    const mb = b / 1024 / 1024;
    return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} MB`;
  }
  function avatar(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const initials = name.trim().split(/\s+/).map((w) => [...w][0]).slice(0, 2).join('').toUpperCase();
    return `<div class="avatar" style="background:hsl(${h % 360} 45% 46%)" aria-hidden="true">${esc(initials)}</div>`;
  }
  const spaceId = () => state.route.space;
  const spaceCode = () => state.me?.reviewCode || creds.get(spaceId()).code || '';
  // Image links carry a short-lived token from /me, never the review code.
  function imageUrl(img) {
    const t = state.me?.imageToken;
    return `${API}/img/${spaceId()}/${img.path.split('/').map(encodeURIComponent).join('/')}${t ? `?t=${encodeURIComponent(t)}` : ''}`;
  }
  // Image tokens look like <expiry, base 36>.<mac>; renew one that ends within the hour.
  const imageTokenExpiring = () => (parseInt(String(state.me?.imageToken || '').split('.')[0], 36) || 0) - Date.now() < 3600e3;
  const reviewLink = (id, code, rest = '') => `${SITE}${code ? `?code=${encodeURIComponent(code)}` : ''}#/${id}${rest}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const usedBytes = () => (state.project?.sections || []).reduce((n, s) => n + s.images.reduce((m, i) => m + (i.bytes || 0), 0), 0);
  const meter = (used, quota) => `<span class="meter" role="img" aria-label="${fmtBytes(used)} of ${fmtBytes(quota)} used"><span style="width:${Math.min(100, quota ? (used / quota) * 100 : 0).toFixed(1)}%" class="${used / quota > 0.9 ? 'full' : ''}"></span></span>`;

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
    return el;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { prompt('Copy this:', text); }
  }

  /* ------------------------------------------------------------------- auth */
  // Clerk is loaded from its own Frontend API host, which the publishable key encodes
  // (pk_test_<base64 of "host$">). 'dev' loads the local stand-in from dev/server.mjs.
  const CLERK_KEY = String((window.REVIEW_CONFIG || {}).clerkPublishableKey || '');
  let clerk = null;
  const loadScript = (src, attrs = {}) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.crossOrigin = 'anonymous';
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(el);
  });
  const clerkReady = (async () => {
    if (!CLERK_KEY) return null;
    try {
      if (CLERK_KEY === 'dev') {
        await loadScript('/dev-clerk.js');
        await window.Clerk.load();
      } else {
        const host = atob(CLERK_KEY.split('_')[2] || '').replace(/\$$/, '');
        if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('clerkPublishableKey in config.js is not valid');
        await loadScript(`https://${host}/npm/@clerk/ui@1/dist/ui.browser.js`);
        await loadScript(`https://${host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { 'data-clerk-publishable-key': CLERK_KEY });
        await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
      }
      clerk = window.Clerk;
      // Signing in or out anywhere (this tab, another tab, a profile change) refreshes the account.
      let last = clerk.user?.id || null;
      clerk.addListener(({ user }) => {
        const now = user?.id || null;
        if (now !== last) { last = now; refreshAccount().then(() => route()); }
      });
      return clerk;
    } catch (err) {
      console.error(err);
      toast('Sign-in is unavailable right now. You can still review with a link.', 'error');
      return null;
    }
  })();
  const signedIn = () => !!clerk?.user;

  async function authHeader(fresh = false) {
    await clerkReady;
    if (!clerk?.session) return {};
    const t = await clerk.session.getToken(fresh ? { skipCache: true } : undefined).catch(() => null);
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  function signIn() {
    if (!clerk) return toast(CLERK_KEY ? 'Sign-in is still loading, try again in a moment.' : 'Sign-in isn’t set up on this site yet.', 'error');
    clerk.openSignIn({ forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
  }

  async function refreshAccount() {
    state.account = signedIn() ? await api('GET', '/api/me', undefined, { space: null }).catch(() => null) : { signedIn: false };
    return state.account;
  }

  /* -------------------------------------------------------------------- api */
  async function api(method, path, body, { space = spaceId(), headers: extra = {} } = {}, retried = false) {
    const headers = { ...extra, ...(await authHeader(retried)) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (space) {
      const c = creds.get(space);
      if (c.key) headers['X-Space-Key'] = c.key;
      if (c.code) headers['X-Review-Code'] = c.code;
    }
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('Could not reach the review server. Check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    // A session token can expire in flight: get a fresh one and try once more.
    if (res.status === 401 && headers.Authorization && !retried) return api(method, path, body, { space, headers: extra }, true);
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Cloudflare Turnstile, only when the Worker turns it on (config.turnstileSiteKey).
  // Resolves to a token for X-Turnstile-Token, or to nothing when it's off.
  let turnstileScript = null;
  async function humanCheck() {
    if (!state.config) state.config = await api('GET', '/api/config', undefined, { space: null }).catch(() => null);
    const sitekey = state.config?.turnstileSiteKey;
    if (!sitekey) return {};
    turnstileScript ||= new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      el.async = true;
      el.onload = () => resolve(window.turnstile);
      el.onerror = () => { turnstileScript = null; reject(new Error('Could not load the “are you human” check. Check your connection and try again.')); };
      document.head.append(el);
    });
    const ts = await turnstileScript;
    const box = document.createElement('div');
    box.className = 'turnstile';
    document.body.append(box);
    let widget;
    try {
      const token = await new Promise((resolve, reject) => {
        widget = ts.render(box, {
          sitekey, appearance: 'interaction-only', callback: resolve,
          'error-callback': () => reject(new Error('The “are you human” check failed. Please try again.')),
        });
      });
      return { 'X-Turnstile-Token': token };
    } finally {
      if (widget !== undefined) ts.remove(widget);
      box.remove();
    }
  }

  // Mutations return the updated section; patch it into local state.
  function applySection(section) {
    const list = state.project.sections;
    const i = list.findIndex((s) => s.id === section.id);
    if (i === -1) list.push(section); else list[i] = section;
  }

  async function run(fn, okMsg) {
    if (state.busy) return;
    state.busy = true;
    document.body.style.cursor = 'progress';
    try {
      const out = await fn();
      if (okMsg) toast(okMsg);
      return out;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      state.busy = false;
      document.body.style.cursor = '';
    }
  }

  /* ----------------------------------------------------------------- router */
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'admin') return { view: 'admin' };
    if (parts[0] === 'invite') return { view: 'invite', token: parts[1] || null };
    if (parts[0] === 'r' && parts[1]) return { view: 'request', rid: parts[1], token: parts[2] || null };
    if (SPACE_RE.test(parts[0] || '')) {
      return { view: 'space', space: parts[0], sid: parts[1] === 's' ? parts[2] || null : null, iid: parts[3] === 'i' ? parts[4] || null : null };
    }
    return { view: 'home' };
  }
  const spaceHash = (id, sid, iid) => `#/${id}${sid ? `/s/${sid}${iid ? `/i/${iid}` : ''}` : ''}`;
  function nav(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
  const go = (sid, iid) => nav(spaceHash(spaceId(), sid, iid));
  window.addEventListener('hashchange', () => route());

  async function route() {
    const prev = state.route;
    const r = parseRoute();
    state.route = r;
    state.menuOpen = false;
    $('#modal-root').innerHTML = '';
    if (r.view === 'space') {
      if (prev.view !== 'space' || prev.space !== r.space || !state.project) return openSpace(r.space);
      if (r.iid !== prev.iid) { state.pinDraft = null; state.replyTo = null; }
      return render();
    }
    state.project = null;
    state.me = null;
    document.body.style.overflow = '';
    if (r.view === 'admin') return openAdmin();
    if (r.view === 'invite') return openInvite(r.token);
    if (r.view === 'request') return openRequest(r.rid, r.token);
    document.title = 'Review Desk';
    render();
    // Home lists the account's spaces and requests.
    await clerkReady;
    if (signedIn() && state.route.view === 'home') { await refreshAccount(); if (state.route.view === 'home') render(); }
  }

  function render() {
    const v = state.route.view;
    if (v === 'space') return renderSpace();
    if (v === 'admin') return renderAdmin();
    if (v === 'request') return renderRequest();
    if (v === 'invite') return renderInvite();
    return renderHome();
  }

  /* ------------------------------------------------------------- page bits */
  const brand = (label = 'Review Desk') => `<a class="brand" href="#/" title="Review Desk home"><div class="brand-mark">${I.logo}</div><span>${esc(label)}</span></a>`;

  // Sign-in button, or the signed-in account (opens Clerk's account page).
  function accountButton() {
    if (!CLERK_KEY) return '';
    if (!signedIn()) return `<button class="btn ghost sm" data-action="sign-in">${I.user}<span class="hide-xs">Sign in</span></button>`;
    const u = clerk.user;
    const name = u.fullName || u.primaryEmailAddress?.emailAddress || 'Account';
    return `<div class="menu-wrap"><button class="btn ghost sm account-btn" data-action="account-menu" aria-haspopup="menu" aria-expanded="${state.menuOpen === 'account'}" title="${esc(name)}">${avatar(name)}<span class="hide-sm">${esc(name)}</span></button>
      ${state.menuOpen === 'account' ? `<div class="menu" role="menu">
        <div class="menu-head">${esc(u.primaryEmailAddress?.emailAddress || '')}</div>
        <button role="menuitem" data-action="manage-account">Manage account and security</button>
        <a role="menuitem" href="#/">Your spaces</a>
        ${state.account?.siteAdmin ? '<a role="menuitem" href="#/admin">Site admin</a>' : ''}
        <button role="menuitem" data-action="sign-out">Sign out</button>
      </div>` : ''}</div>`;
  }

  function page(inner) {
    $('#app').innerHTML = `<header class="topbar">${brand()}<div class="spacer"></div>${accountButton()}</header><main class="page">${inner}</main>`;
  }
  function loading() { $('#app').innerHTML = '<div class="boot">Loading…</div>'; }

  function notice({ icon = '', tone = '', title, text = '', actions = '' }) {
    page(`<div class="notice ${tone}">${icon ? `<div class="notice-icon">${icon}</div>` : ''}<h1>${esc(title)}</h1>${text ? `<p>${text}</p>` : ''}${actions ? `<div class="notice-actions">${actions}</div>` : ''}</div>`);
  }
  const homeBtn = '<a class="btn" href="#/">Go to home page</a>';

  function copyField(label, value, { secret = false } = {}) {
    return `<div class="copy-field">
      <label>${esc(label)}</label>
      <div class="cf-row">
        <input class="input mono" readonly value="${esc(value)}" ${secret ? 'data-secret' : ''} aria-label="${esc(label)}">
        <button type="button" class="btn sm" data-action="copy" data-text="${esc(value)}">Copy</button>
      </div>
    </div>`;
  }

  /* ------------------------------------------------------------------- home */
  function renderHome() {
    const cfg = state.config;
    const demoId = store.get('demo');
    const demo = demoId ? creds.get(demoId) : null;
    const demoActive = demo?.key && Date.parse(demo.expiresAt) > Date.now();
    const quota = cfg ? fmtBytes(cfg.demo.quotaBytes) : '5 MB';
    const hours = cfg ? cfg.demo.hours : 24;

    const acct = state.account?.signedIn ? state.account : null;
    const mine = acct?.spaces || [];
    const mineIds = new Set(mine.map((x) => x.id));
    // Demos and review links live on this device; account spaces come from the server.
    const spaces = Object.entries(creds.all())
      .filter(([id, c]) => (c.key || c.code) && !mineIds.has(id) && !(c.kind === 'demo' && c.expiresAt && Date.parse(c.expiresAt) < Date.now()) && SPACE_RE.test(id))
      .sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0));
    const reqs = myRequests();
    const roleLabel = (r) => ({ owner: 'Owner', editor: 'Editor' }[r] || r);

    $('#app').innerHTML = `
      <header class="topbar">${brand()}<div class="spacer"></div>
        <button class="btn ghost sm hide-xs" data-action="request-space">Request a space</button>
        ${accountButton()}
      </header>
      <main class="page home">
        <section class="hero">
          <h1>Feedback pinned to the exact spot.</h1>
          <p>Upload screenshots, share one link, and let clients comment right on the design. Reviewers don’t need an account.</p>
        </section>
        <div class="options">
          <article class="option accent">
            <div class="option-icon">${I.spark}</div>
            <h2>Try it now</h2>
            <p>A private demo space with ${quota} of storage. No sign-up. Everything is deleted after ${hours} hours.</p>
            <div class="option-foot">
              ${demoActive
                ? `<a class="btn primary" href="#/${demoId}">Continue your demo</a><span class="muted">${timeLeft(demo.expiresAt)} left</span>`
                : `<button class="btn primary" data-action="start-demo" ${cfg && !cfg.demo.enabled ? 'disabled title="Demos are turned off"' : ''}>Start a demo</button>`}
            </div>
          </article>
          <article class="option">
            <div class="option-icon">${I.box}</div>
            <h2>Get your own space</h2>
            <p>For real projects: ${cfg ? fmtBytes(cfg.spaceQuotaBytes) : 'more'} of storage, nothing expires, and you can invite your team. Tell us what it’s for and an admin will set it up.</p>
            <div class="option-foot"><button class="btn" data-action="request-space">${signedIn() || !CLERK_KEY ? 'Request a space' : 'Sign in to request a space'}</button></div>
          </article>
          <article class="option">
            <div class="option-icon">${I.key}</div>
            <h2>Have a link?</h2>
            <p>Paste a review link someone sent you, or a space key from before accounts.</p>
            <form class="option-foot open-form" data-form="open">
              <label class="sr-only" for="open-value">Space key or review link</label>
              <input class="input" id="open-value" name="value" placeholder="https://… or sk-…" autocomplete="off" autocapitalize="off" spellcheck="false" required>
              <button class="btn" type="submit">Open</button>
            </form>
          </article>
        </div>

        ${acct?.adminNeedsMfa ? `<div class="notice-box warn">${I.shield}<span>Your account is a site admin, but the admin console needs two-step verification. <button class="link-btn" data-action="manage-account">Turn it on in your account</button>, then sign in again.</span></div>` : ''}

        ${mine.length ? `<section class="list-block">
          <h3>Your spaces</h3>
          <div class="rows">${mine.map((x) => `
            <div class="row-item">
              <a class="ri-main" href="#/${esc(x.id)}">
                <span class="ri-title">${esc(x.title)}</span>
                <span class="ri-sub"><span class="pill">Space</span> · ${esc(roleLabel(x.role))}</span>
              </a>
            </div>`).join('')}
          </div>
        </section>` : ''}

        ${acct?.requests?.length ? `<section class="list-block">
          <h3>Your space requests</h3>
          <div class="rows">${acct.requests.map((r) => `
            <div class="row-item">
              ${r.status === 'approved' && r.spaceId ? `<a class="ri-main" href="#/${esc(r.spaceId)}">` : '<div class="ri-main">'}
                <span class="ri-title">${esc(r.organization || 'Space request')} · ${esc(ago(r.createdAt))}</span>
                <span class="ri-sub"><span class="pill status-${esc(r.status)}">${esc(statusLabel(r.status))}</span>${r.reason ? ` · ${esc(r.reason)}` : ''}</span>
              ${r.status === 'approved' && r.spaceId ? '</a>' : '</div>'}
            </div>`).join('')}
          </div>
        </section>` : ''}

        ${spaces.length ? `<section class="list-block">
          <h3>${mine.length ? 'Also on this device' : 'On this device'}</h3>
          <div class="rows">${spaces.map(([id, c]) => `
            <div class="row-item">
              <a class="ri-main" href="#/${id}">
                <span class="ri-title">${esc(c.title || 'Untitled space')}</span>
                <span class="ri-sub">${c.kind === 'demo' ? `<span class="pill demo">Demo</span> ends in ${timeLeft(c.expiresAt)}` : '<span class="pill">Space</span>'} · ${c.key ? 'Owner' : 'Reviewer'}</span>
              </a>
              <button class="btn ghost icon sm" data-action="forget-space" data-id="${id}" title="Forget on this device" aria-label="Forget ${esc(c.title || 'space')} on this device">${I.close}</button>
            </div>`).join('')}
          </div>
        </section>` : ''}

        ${reqs.length ? `<section class="list-block">
          <h3>Earlier requests on this device</h3>
          <div class="rows">${reqs.map((r) => `
            <div class="row-item">
              <a class="ri-main" href="#/r/${esc(r.id)}">
                <span class="ri-title">Request from ${esc(ago(r.createdAt))}</span>
                <span class="ri-sub">${esc(r.lastStatus ? statusLabel(r.lastStatus) : 'Check status')}</span>
              </a>
            </div>`).join('')}
          </div>
        </section>` : ''}

        <footer class="home-foot"><a href="#/admin">Site admin</a></footer>
      </main>`;
  }

  function openFromInput(value) {
    const v = value.trim();
    const k = v.match(KEY_RE);
    if (k) { creds.set(k[1], { key: v }); return nav(spaceHash(k[1])); }
    try {
      const u = new URL(v);
      const rest = u.hash.replace(/^#\/?/, '');
      const id = rest.split('/')[0];
      if (SPACE_RE.test(id)) {
        const code = u.searchParams.get('code');
        if (code) creds.set(id, { code });
        return nav(`#/${rest}`);
      }
    } catch { /* not a URL */ }
    if (SPACE_RE.test(v)) return nav(spaceHash(v));
    toast('Paste a space key (starts with sk-) or the full review link', 'error');
  }

  /* --------------------------------------------------------------- requests */
  const statusLabel = (s) => ({ pending: 'Waiting for approval', approved: 'Approved', rejected: 'Not approved' }[s] || s);

  async function openRequest(id, tokenFromUrl) {
    let list = myRequests();
    let entry = list.find((r) => r.id === id);
    if (tokenFromUrl) {
      if (!entry) { entry = { id, token: tokenFromUrl, createdAt: new Date().toISOString() }; list.push(entry); saveRequests(list); }
      history.replaceState(null, '', `${location.pathname}#/r/${id}`); // keep the token out of the address bar
    }
    if (!entry) {
      return notice({ title: 'Request not found on this device', text: 'Open the status link you saved when you sent the request.', actions: homeBtn });
    }
    loading();
    try {
      state.request = await api('POST', `/api/requests/${id}/status`, { token: entry.token }, { space: null });
    } catch (e) {
      return notice({ title: 'Couldn’t load this request', text: esc(e.message), actions: homeBtn });
    }
    const st = state.request;
    if (st.adminKey) creds.set(st.spaceId, { key: st.adminKey, code: st.reviewCode, title: st.title, kind: 'space' });
    list = myRequests();
    const i = list.findIndex((r) => r.id === id);
    if (i !== -1) { list[i].lastStatus = st.status; saveRequests(list); }
    document.title = 'Space request · Review Desk';
    render();
  }

  function renderRequest() {
    const st = state.request;
    if (!st) return loading();
    const entry = myRequests().find((r) => r.id === st.id);
    const statusLink = entry ? `${SITE}#/r/${st.id}/${entry.token}` : '';
    const local = st.spaceId ? creds.get(st.spaceId) : {};

    if (st.status === 'pending') {
      return notice({
        icon: I.clock, title: 'Request received',
        text: `An admin will review it soon. This page shows the result when you come back.</p>
          <div class="notice-box">${copyField('Status link (keep it private; it collects your space key once approved)', statusLink, { secret: true })}</div><p class="muted">Sent ${esc(ago(st.createdAt))}.`,
        actions: `<button class="btn primary" data-action="check-request">${I.refresh}Check again</button>${homeBtn}`,
      });
    }
    if (st.status === 'rejected') {
      return notice({
        icon: I.x, tone: 'danger', title: 'Request not approved',
        text: st.reason ? `Reason: ${esc(st.reason)}` : 'The admin didn’t approve this request.',
        actions: `<button class="btn" data-action="drop-request" data-id="${esc(st.id)}">Remove from this list</button>${homeBtn}`,
      });
    }
    // approved
    if (local.key) {
      return notice({
        icon: I.check, tone: 'ok', title: 'Your space is ready',
        text: `Your space key is saved in this browser. Copy it somewhere safe, like a password manager. <b>It can’t be retrieved again</b>, and you need it to manage the space from another device.</p>
          <div class="notice-box">
            ${copyField('Space key (owner access; keep it private)', local.key, { secret: true })}
            ${local.code ? copyField('Reviewer link (share this with your reviewers)', reviewLink(st.spaceId, local.code)) : ''}
          </div><p>`,
        actions: `<a class="btn primary" href="#/${st.spaceId}">Open your space</a>`,
      });
    }
    return notice({
      icon: I.check, tone: 'ok', title: 'Your space was approved',
      text: 'The space key was already collected, probably on another device or browser. If you’ve lost it, contact the admin who approved your request.',
      actions: homeBtn,
    });
  }

  /* ---------------------------------------------------------------- invites */
  // The token comes in the link's fragment. It's moved to this tab's storage and
  // taken out of the address bar, so it survives a social-login round trip but
  // doesn't stay in history.
  async function openInvite(tokenFromUrl) {
    if (tokenFromUrl) {
      session.set('invite', tokenFromUrl);
      history.replaceState(null, '', `${location.pathname}${location.search}#/invite`);
    }
    const token = session.get('invite');
    document.title = 'Invite · Review Desk';
    if (!token) return notice({ title: 'Invite link missing', text: 'Open the link from your invite email again.', actions: homeBtn });
    loading();
    try {
      state.invite = await api('GET', `/api/invites/${encodeURIComponent(token)}`, undefined, { space: null });
    } catch (e) {
      session.set('invite', null);
      return notice({ icon: I.x, tone: 'danger', title: 'This invite can’t be used', text: esc(e.message), actions: homeBtn });
    }
    await clerkReady;
    render();
  }

  function renderInvite() {
    const inv = state.invite;
    if (!inv) return loading();
    const role = inv.role === 'owner' ? 'an owner' : 'an editor';
    if (inv.status !== 'pending') {
      session.set('invite', null);
      const why = { accepted: 'has already been used', revoked: 'was cancelled', expired: 'has expired' }[inv.status];
      return notice({ icon: I.x, tone: 'danger', title: `This invite ${why}`, text: `Ask ${esc(inv.inviter)} to send a new one.`, actions: homeBtn });
    }
    const who = signedIn() ? clerk.user.primaryEmailAddress?.emailAddress : '';
    notice({
      icon: I.mail, title: `Join “${esc(inv.title)}”`,
      text: `${esc(inv.inviter)} invited you to be ${role} of this space. The invite is for <b>${esc(inv.email)}</b> and expires ${esc(ago(inv.expiresAt))}.${who ? `</p><p class="muted">Signed in as ${esc(who)}.` : ''}`,
      actions: signedIn()
        ? `<button class="btn primary" data-action="accept-invite">${I.check}Accept invite</button><button class="btn" data-action="sign-out">Use another account</button>`
        : `<button class="btn primary" data-action="sign-in">${I.user}Sign in to accept</button>${homeBtn}`,
    });
  }

  /* ---------------------------------------------------------------- spaces */
  async function openSpace(id) {
    state.project = null;
    state.me = null;
    loading();
    let me;
    try {
      me = await api('GET', `/api/s/${id}/me`, undefined, { space: id });
    } catch (e) {
      if (e.status === 410) {
        creds.forget(id);
        if (store.get('demo') === id) store.set('demo', null);
        return notice({
          icon: I.clock, title: 'This demo has ended',
          text: 'Demo spaces and their screenshots are deleted automatically when they expire.',
          actions: '<button class="btn primary" data-action="start-demo">Start a new demo</button><button class="btn" data-action="request-space">Request a space</button>',
        });
      }
      if (e.status === 404) return notice({ title: 'Space not found', text: 'It may have been deleted, or the link is incomplete.', actions: homeBtn });
      return notice({ title: 'Can’t reach the review server', text: esc(e.message), actions: '<button class="btn" data-action="reload">Try again</button>' });
    }
    const c = creds.get(id);
    if (c.key && !me.admin) creds.set(id, { key: null }); // the key was rotated
    if (!me.authorized) {
      if (c.code) creds.set(id, { code: null });
      return spaceGate(id, c.code ? 'That review code no longer works. Ask for a new link.' : '', me.space);
    }
    state.me = me;
    state.members = null;
    state.shareTab = 'reviewers';
    if (c.key || c.code) creds.set(id, { title: me.space.title, kind: me.space.kind, expiresAt: me.space.expiresAt, ...(c.key ? { code: me.reviewCode } : {}) });
    await load();
    if (state.welcome === id) { state.welcome = null; welcomeDemo(); }
  }

  async function load({ quiet = false } = {}) {
    const id = spaceId();
    try {
      if (state.me && imageTokenExpiring()) state.me = await api('GET', `/api/s/${id}/me`);
      state.project = await api('GET', `/api/s/${id}/project`);
      state.lastLoad = Date.now();
      document.title = `${state.project.title} · Review Desk`;
      render();
    } catch (e) {
      if ([401, 404, 410].includes(e.status)) return openSpace(id);
      if (!quiet) toast(e.message, 'error');
    }
  }

  function spaceGate(id, message, info, asOwner = false) {
    const demo = info?.kind === 'demo';
    page(`
      <form class="card-form" id="gate-form" novalidate>
        <h1>${asOwner ? 'Use a space key' : 'Enter the review code'}</h1>
        <p>${asOwner ? 'Paste the space key you received when the space was created (spaces made before accounts).' : 'You should have received it with the link to this page.'}${demo && info.expiresAt ? ` This demo space ends in ${timeLeft(info.expiresAt)}.` : ''}</p>
        ${!asOwner && CLERK_KEY && !signedIn() ? `<p class="muted">Owner or editor? <button type="button" class="link-btn" data-action="sign-in">Sign in</button> instead.</p>` : ''}
        <div class="field">
          <label for="gate-value">${asOwner ? 'Space key' : 'Review code'}</label>
          <input class="input ${asOwner ? 'mono' : 'code-input'}" id="gate-value" ${asOwner ? 'type="password" placeholder="sk-…"' : 'placeholder="ABCD-EFGH-JKMN" autocapitalize="characters"'} autocomplete="off" spellcheck="false" required>
        </div>
        ${message ? `<div class="err">${esc(message)}</div>` : ''}
        <div class="row">
          <button type="button" class="link-btn" id="gate-switch">${asOwner ? 'I have a review code' : 'I have a space key'}</button>
          <button class="btn primary" type="submit">Continue</button>
        </div>
      </form>`);
    $('#gate-value').focus();
    $('#gate-switch').onclick = () => spaceGate(id, '', info, !asOwner);
    $('#gate-form').onsubmit = (e) => {
      e.preventDefault();
      const v = $('#gate-value').value.trim();
      if (!v) return;
      if (asOwner) {
        const m = v.match(KEY_RE);
        if (!m) return spaceGate(id, 'That doesn’t look like a space key. It starts with “sk-”.', info, true);
        if (m[1] !== id) return spaceGate(id, 'That key belongs to a different space.', info, true);
        creds.set(id, { key: v });
      } else {
        creds.set(id, { code: v });
      }
      openSpace(id);
    };
  }

  function welcomeDemo() {
    const p = state.project.space;
    modal({
      title: 'Your demo space is ready',
      text: `You own this space. Create a section, upload screenshots (up to ${fmtBytes(p.quotaBytes)} in total), then use <b>Share</b> to invite reviewers. Everything is deleted automatically in ${timeLeft(p.expiresAt)}.`,
      confirm: 'Get started', cancel: false,
      onSubmit: () => {},
    });
  }

  const currentSection = () => state.project?.sections.find((s) => s.id === state.route.sid) || state.project?.sections[0] || null;
  const openCount = (comments, target) => comments.filter((c) => !c.parentId && !c.resolved && (target === undefined || c.target === target)).length;

  function renderSpace() {
    const app = $('#app');
    if (!state.project) return;

    // Keep focus + caret in whichever composer the user is typing in.
    const active = document.activeElement;
    const focusKey = active?.dataset?.draft;
    const caret = focusKey ? [active.selectionStart, active.selectionEnd] : null;
    const scrollers = [...document.querySelectorAll('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollTop]);

    const section = currentSection();
    if (section && state.route.sid !== section.id && !state.route.iid) state.route.sid = section.id;

    app.innerHTML = `
      ${spaceTopbar()}
      ${spaceStrip()}
      <div class="shell">
        ${sidebar(section)}
        <main class="main">${section ? sectionView(section) : emptyProject()}</main>
      </div>
      ${section && state.route.iid ? viewer(section) : ''}`;
    document.body.style.overflow = state.route.iid ? 'hidden' : '';

    for (const [key, top] of scrollers) { const el = document.querySelector(`[data-keep-scroll="${key}"]`); if (el) el.scrollTop = top; }
    if (focusKey) {
      const el = document.querySelector(`[data-draft="${focusKey}"]`);
      if (el) { el.focus(); if (caret) el.setSelectionRange(...caret); }
    }
  }

  function spaceTopbar() {
    const admin = isAdmin();
    const p = state.project;
    return `
      <header class="topbar">
        <a class="brand" href="#/" title="Review Desk home"><div class="brand-mark">${I.logo}</div></a>
        <div class="tb-title">
          <span class="t">${esc(p.title)}</span>
          ${admin ? `<button class="btn ghost sm icon" data-action="rename-project" title="Rename space" aria-label="Rename space">${I.edit}</button>` : ''}
        </div>
        <div class="spacer"></div>
        <button class="btn ghost sm" data-action="refresh" title="Load latest comments" aria-label="Refresh">${I.refresh}<span class="hide-sm">Refresh</span></button>
        ${admin ? `<button class="btn primary sm" data-action="share" title="Invite reviewers and your team" aria-label="Share">${I.share}<span class="hide-xs">Share</span></button>` : ''}
        <div class="menu-wrap">
          <button class="btn ghost sm icon" data-action="menu" aria-haspopup="menu" aria-expanded="${state.menuOpen === 'space'}" title="More" aria-label="More options">${I.dots}</button>
          ${state.menuOpen === 'space' ? spaceMenu() : ''}
        </div>
        ${accountButton()}
      </header>`;
  }

  const roleName = () => ({ 'site-admin': 'Site admin', owner: 'Owner', editor: 'Editor' }[state.me?.role] || 'Reviewer');

  function spaceMenu() {
    const admin = isAdmin();
    const c = creds.get(spaceId());
    const demo = state.project.space.kind === 'demo';
    const member = ['owner', 'editor'].includes(state.me.role) && !c.key;
    return `<div class="menu" role="menu">
      <div class="menu-head">${esc(roleName())}${!signedIn() && state.name ? ` · ${esc(state.name)}` : ''}</div>
      ${signedIn() ? '' : `<button role="menuitem" data-action="change-name">${state.name ? 'Change your name' : 'Set your name'}</button>`}
      ${admin ? '<button role="menuitem" data-action="rotate-code">New review code…</button>' : ''}
      ${!admin ? '<button role="menuitem" data-action="owner-in">Use a space key…</button>' : ''}
      ${admin && c.key ? '<button role="menuitem" data-action="owner-out">Stop using the space key</button>' : ''}
      ${member && state.me.role !== 'site-admin' ? '<button role="menuitem" data-action="leave-space">Leave this space…</button>' : ''}
      <button role="menuitem" data-action="forget-space" data-id="${spaceId()}">Forget on this device</button>
      ${demo && admin ? '<button role="menuitem" class="danger" data-action="delete-demo">Delete this demo now…</button>' : ''}
      <a role="menuitem" href="#/">All spaces</a>
    </div>`;
  }

  function spaceStrip() {
    const s = state.project.space;
    const used = usedBytes();
    if (s.kind === 'demo') {
      return `<div class="strip demo">
        <span>${I.clock}<b>Demo</b> · deleted in ${timeLeft(s.expiresAt)}</span>
        ${isAdmin() ? `<span class="strip-usage">${meter(used, s.quotaBytes)}${fmtBytes(used)} of ${fmtBytes(s.quotaBytes)}</span>` : ''}
        <button class="link-btn" data-action="request-space">Get a permanent space</button>
      </div>`;
    }
    // Space key holders of older spaces are asked to move to an account.
    const claim = state.me.canClaim
      ? `<span class="strip-claim">${I.shield}You’re using a space key. <button class="link-btn" data-action="claim-space">Make your account the owner</button></span>`
      : creds.get(spaceId()).key && !signedIn() && CLERK_KEY
        ? `<span class="strip-claim">${I.shield}You’re using a space key. <button class="link-btn" data-action="sign-in">Sign in</button> to move this space to your account.</span>`
        : '';
    if (!isAdmin()) return claim ? `<div class="strip">${claim}</div>` : '';
    return `<div class="strip">${claim}<span class="strip-usage">Storage ${meter(used, s.quotaBytes)}${fmtBytes(used)} of ${fmtBytes(s.quotaBytes)}</span></div>`;
  }

  function sidebar(current) {
    const items = state.project.sections.map((s) => {
      const open = openCount(s.comments);
      return `<button class="nav-item ${current?.id === s.id ? 'active' : ''}" data-action="open-section" data-sid="${s.id}">
        <span class="name">${esc(s.title)}</span>
        ${open ? `<span class="count hot" title="${plural(open, 'open comment')}">${open}</span>` : `<span class="count" title="${plural(s.images.length, 'screenshot')}">${s.images.length}</span>`}
      </button>`;
    }).join('');
    return `
      <nav class="sidebar" aria-label="Sections">
        <h2>Sections</h2>
        ${items}
        ${isAdmin() ? `<button class="btn sm add" data-action="new-section">${I.plus}New section</button>` : ''}
      </nav>`;
  }

  function emptyProject() {
    return isAdmin()
      ? `<div class="empty"><h3>No sections yet</h3><p>Create a section (e.g. “Onboarding”, “Checkout”) and upload screenshots into it.</p><button class="btn primary" data-action="new-section">${I.plus}Create first section</button></div>`
      : '<div class="empty"><h3>Nothing to review yet</h3><p>Screenshots will appear here once the team uploads them.</p></div>';
  }

  function sectionView(s) {
    const admin = isAdmin();
    const open = openCount(s.comments);
    const cards = s.images.map((img) => {
      const n = openCount(s.comments, img.id);
      return `<button class="card" data-action="open-image" data-iid="${img.id}" aria-label="Open ${esc(img.caption || img.name)}">
        <div class="thumb"><img src="${esc(imageUrl(img))}" alt="" loading="lazy"></div>
        ${n ? `<span class="badge hot">${I.chat}${n}</span>` : ''}
        <div class="card-body"><span class="cap">${esc(img.caption || img.name)}<span class="sub">${ago(img.uploadedAt)}</span></span></div>
      </button>`;
    }).join('');

    return `
      <div class="section-head">
        <div class="titles">
          <h1>${esc(s.title)}</h1>
          ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ''}
          <div class="meta">${plural(s.images.length, 'screenshot')} · ${plural(open, 'open comment')}</div>
        </div>
        <div class="actions">
          <button class="btn sm" data-action="copy-link" data-sid="${s.id}">${I.link}Copy link</button>
          ${admin ? `
            <button class="btn sm" data-action="edit-section">${I.edit}Edit</button>
            <button class="btn sm danger" data-action="delete-section">${I.trash}Delete</button>
            <button class="btn sm primary" data-action="pick-files">${I.upload}Upload</button>` : ''}
        </div>
      </div>
      ${admin ? `<div class="dropzone" id="dropzone">${I.upload}<span>${coarse ? 'Tap Upload to add screenshots' : 'Drop screenshots here<span class="long">, or paste one with Ctrl/⌘ + V</span>'}</span></div>
        <input type="file" id="file-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>` : ''}
      ${s.images.length ? `<div class="grid">${cards}</div>` : `<div class="empty"><h3>No screenshots in this section</h3><p>${admin ? 'Upload some to start collecting feedback.' : 'Check back soon.'}</p></div>`}
      <section class="feedback">
        <div class="feedback-head"><h2>Section feedback</h2><p>General thoughts on this flow as a whole</p></div>
        ${threads(s, 'section')}
        ${composer(s, 'section')}
      </section>`;
  }

  function threads(s, target) {
    const all = s.comments.filter((c) => c.target === target && !c.parentId);
    const pinNo = pinNumbers(s, target);
    const showRes = !!state.showResolved[target];
    const visible = all.filter((c) => showRes || !c.resolved);
    const hidden = all.length - visible.length;

    const html = visible.map((c) => {
      const replies = s.comments.filter((r) => r.parentId === c.id);
      return `<div class="thread ${c.resolved ? 'resolved' : ''} ${state.highlight === c.id ? 'hl' : ''}" data-cid="${c.id}">
        ${comment(c, pinNo[c.id])}
        ${replies.length ? `<div class="replies">${replies.map((r) => comment(r)).join('')}</div>` : ''}
        ${state.replyTo === c.id ? `<div class="reply-box">${composer(s, target, c.id)}</div>` : ''}
      </div>`;
    }).join('');

    return `<div class="threads">
      ${html || (hidden ? '' : `<div class="no-comments">No comments yet${target === 'section' ? '' : ` — ${coarse ? 'tap' : 'click'} the screenshot to pin one`}.</div>`)}
      ${hidden || showRes && all.some((c) => c.resolved) ? `<button class="link-btn resolved-toggle" data-action="toggle-resolved" data-target="${target}">${showRes ? 'Hide resolved' : `Show ${plural(hidden, 'resolved comment')}`}</button>` : ''}
    </div>`;
  }

  function comment(c, pinNo) {
    const admin = isAdmin();
    const top = !c.parentId;
    return `<div class="comment">
      ${avatar(c.author)}
      <div>
        <div class="c-head">
          ${pinNo ? `<span class="pin-tag" title="Pinned on the screenshot">${pinNo}</span>` : ''}
          <span class="who">${esc(c.author)}</span>${c.verified ? `<span class="verified" title="Signed in">${I.check}</span>` : ''}
          <span class="when" title="${esc(new Date(c.createdAt).toLocaleString())}">${ago(c.createdAt)}</span>
          ${c.resolved ? '<span class="tag-resolved">✓ Resolved</span>' : ''}
        </div>
        <div class="c-text">${esc(c.text)}</div>
        <div class="c-actions">
          ${top ? `<button class="link-btn" data-action="reply" data-cid="${c.id}">Reply</button>` : ''}
          ${admin && top ? `<button class="link-btn" data-action="resolve" data-cid="${c.id}" data-val="${c.resolved ? '0' : '1'}">${c.resolved ? 'Reopen' : 'Resolve'}</button>` : ''}
          ${admin ? `<button class="link-btn danger" data-action="delete-comment" data-cid="${c.id}">Delete</button>` : ''}
        </div>
      </div>
    </div>`;
  }

  function composer(s, target, parentId = null) {
    const key = `${s.id}:${target}:${parentId || ''}`;
    const isImage = target !== 'section' && !parentId;
    const placeholder = parentId ? 'Write a reply…' : isImage ? (state.pinDraft ? 'What about this spot?' : `Comment on this screenshot, or ${coarse ? 'tap' : 'click'} it to pin a spot…`) : 'Share feedback on this section…';
    return `<form class="composer" data-action="post" data-target="${target}" data-parent="${parentId || ''}" data-key="${key}">
      ${isImage && state.pinDraft ? `<div class="pin-draft">${I.pin.replace('<svg', '<svg width="13" height="13"')}Pinned to a spot<button type="button" data-action="clear-pin" aria-label="Remove pin">×</button></div>` : ''}
      <label class="sr-only" for="ta-${esc(key)}">${placeholder}</label>
      <textarea class="textarea" id="ta-${esc(key)}" data-draft="${esc(key)}" rows="${parentId ? 2 : 3}" maxlength="2000" placeholder="${placeholder}" required>${esc(state.drafts[key] || '')}</textarea>
      <div class="row">
        ${signedIn()
          ? `<span class="as">Commenting as <b>${esc(clerk.user.fullName || clerk.user.primaryEmailAddress?.emailAddress || '')}</b></span>`
          : state.name
            ? `<span class="as">Commenting as <b>${esc(state.name)}</b></span>`
            : '<input class="input name-input" name="author" placeholder="Your name" maxlength="60" required autocomplete="name"><span class="as"></span>'}
        ${parentId ? '<button type="button" class="btn ghost sm" data-action="cancel-reply">Cancel</button>' : ''}
        <button class="btn primary sm" type="submit">${parentId ? 'Reply' : 'Post'}</button>
      </div>
    </form>`;
  }

  function pinNumbers(s, target) {
    const out = {};
    let n = 0;
    for (const c of s.comments) if (c.target === target && !c.parentId && c.pin) out[c.id] = ++n;
    return out;
  }

  function viewer(s) {
    const idx = s.images.findIndex((i) => i.id === state.route.iid);
    if (idx === -1) return '';
    const img = s.images[idx];
    const nums = pinNumbers(s, img.id);
    const showRes = !!state.showResolved[img.id];
    const pins = s.comments
      .filter((c) => c.target === img.id && !c.parentId && c.pin && (showRes || !c.resolved))
      .map((c) => `<button class="pin ${c.resolved ? 'resolved' : ''} ${state.highlight === c.id ? 'hl' : ''}" style="left:${c.pin.x}%;top:${c.pin.y}%" data-action="focus-comment" data-cid="${c.id}" title="${esc(c.author)}: ${esc(c.text.slice(0, 80))}"><span>${nums[c.id]}</span></button>`)
      .join('');
    const draft = state.pinDraft ? `<div class="pin draft" style="left:${state.pinDraft.x}%;top:${state.pinDraft.y}%"><span>+</span></div>` : '';
    const fit = store.get('fit') !== '0';

    return `
      <div class="viewer" role="dialog" aria-modal="true" aria-label="${esc(img.caption || img.name)}">
        <div class="viewer-bar">
          <button class="btn ghost icon" data-action="close-viewer" title="Close (Esc)" aria-label="Close">${I.close}</button>
          <div class="title"><b>${esc(img.caption || img.name)}</b><small>${esc(s.title)} · ${idx + 1} / ${s.images.length}</small></div>
          <div class="vtools">
            <button class="btn ghost icon hide-sm" data-action="toggle-fit" title="${fit ? 'Actual size' : 'Fit to screen'}" aria-label="${fit ? 'Actual size' : 'Fit to screen'}">${I.fit}</button>
            <button class="btn ghost icon hide-sm" data-action="copy-link" data-sid="${s.id}" data-iid="${img.id}" title="Copy link to this screenshot" aria-label="Copy link">${I.link}</button>
            ${isAdmin() ? `<button class="btn ghost icon" data-action="edit-caption" title="Edit caption" aria-label="Edit caption">${I.edit}</button>
              <button class="btn ghost icon danger" data-action="delete-image" title="Delete screenshot" aria-label="Delete screenshot">${I.trash}</button>` : ''}
            <button class="btn ghost icon" data-action="nav-image" data-dir="-1" title="Previous (←)" aria-label="Previous" ${idx === 0 ? 'disabled' : ''}>${I.left}</button>
            <button class="btn ghost icon" data-action="nav-image" data-dir="1" title="Next (→)" aria-label="Next" ${idx === s.images.length - 1 ? 'disabled' : ''}>${I.right}</button>
          </div>
        </div>
        <div class="viewer-body" data-keep-scroll="body">
          <div class="stage ${fit ? 'fit' : ''}" data-keep-scroll="stage">
            <div class="canvas" id="canvas">
              <img src="${esc(imageUrl(img))}" alt="${esc(img.caption || img.name)}" draggable="false">
              ${pins}${draft}
            </div>
          </div>
          <aside class="panel">
            <div class="panel-scroll" data-keep-scroll="panel">
              <p class="caption">Comments</p>
              <div class="hint">${I.pin}<span>${coarse ? 'Tap' : 'Click'} anywhere on the screenshot to pin a comment to that exact spot.</span></div>
              ${threads(s, img.id)}
            </div>
            <div class="panel-foot">${state.replyTo && s.comments.some((c) => c.id === state.replyTo && c.target === img.id) ? '' : composer(s, img.id)}</div>
          </aside>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------- site admin */
  async function openAdmin() {
    document.title = 'Site admin · Review Desk';
    loading();
    await clerkReady;
    if (!signedIn()) {
      return notice({ icon: I.shield, title: 'Site admin', text: 'Sign in with a site admin account to approve requests and manage spaces.', actions: `<button class="btn primary" data-action="sign-in">${I.user}Sign in</button>${homeBtn}` });
    }
    await refreshAccount();
    if (!state.account?.siteAdmin) {
      return notice(state.account?.adminNeedsMfa
        ? { icon: I.shield, title: 'Turn on two-step verification', text: 'The admin console needs two-step verification on your account. Turn it on, then sign out and in again.', actions: `<button class="btn primary" data-action="manage-account">Open account security</button><button class="btn" data-action="sign-out">Sign out</button>` }
        : { icon: I.shield, tone: 'danger', title: 'Not a site admin', text: `${esc(clerk.user.primaryEmailAddress?.emailAddress || 'This account')} isn’t a site admin.`, actions: `<button class="btn" data-action="sign-out">Use another account</button>${homeBtn}` });
    }
    try {
      state.overview = await api('GET', '/api/admin/overview', undefined, { space: null });
    } catch (e) {
      return notice({ title: 'Can’t load the admin console', text: esc(e.message), actions: '<button class="btn" data-action="reload">Try again</button>' });
    }
    state.usage = {};
    render();
    loadUsage();
    if (state.adminTab === 'activity') loadAudit();
  }

  async function loadAudit() {
    state.audit = null;
    try {
      state.audit = await api('GET', '/api/admin/audit', undefined, { space: null });
    } catch (e) {
      state.audit = { error: e.message };
    }
    if (state.route.view === 'admin' && state.adminTab === 'activity') render();
  }

  // Usage needs one read per space, so it loads per space after the list renders.
  function loadUsage() {
    const ids = [...state.overview.spaces.map((s) => s.id), ...state.overview.demos.map((d) => d.id)];
    let pending = 0;
    const flush = () => { if (state.route.view === 'admin') render(); };
    for (const id of ids) {
      pending++;
      api('GET', `/api/admin/spaces/${id}`, undefined, { space: null })
        .then((info) => { state.usage[id] = info; })
        .catch((e) => { state.usage[id] = { error: e.message }; })
        .finally(() => { if (--pending === 0 || pending % 5 === 0) flush(); });
    }
  }

  function renderAdmin() {
    const o = state.overview;
    if (!o) return loading();
    const pending = o.requests.filter((r) => r.status === 'pending').length;
    const tab = state.adminTab;
    const tabs = [['requests', 'Requests', pending], ['spaces', 'Spaces', o.spaces.length], ['demos', 'Demos', o.demos.length], ['activity', 'Activity', 0]];
    const body = tab === 'spaces' ? adminSpaces(o) : tab === 'demos' ? adminDemos(o) : tab === 'activity' ? adminActivity() : adminRequests(o);

    $('#app').innerHTML = `
      <header class="topbar">${brand()}<span class="chip admin hide-xs">Site admin</span><div class="spacer"></div>
        <button class="btn ghost sm" data-action="admin-refresh" aria-label="Refresh">${I.refresh}<span class="hide-sm">Refresh</span></button>
        <button class="btn primary sm" data-action="admin-new-space">${I.plus}<span class="hide-xs">New space</span></button>
        ${accountButton()}
      </header>
      <main class="page admin">
        <div class="tabs" role="tablist">
          ${tabs.map(([k, label, n]) => `<button role="tab" class="tab ${tab === k ? 'active' : ''}" aria-selected="${tab === k}" data-action="admin-tab" data-tab="${k}">${label}${n ? `<span class="count ${k === 'requests' && n ? 'hot' : ''}">${n}</span>` : ''}</button>`).join('')}
        </div>
        ${body}
      </main>`;
  }

  function usageLine(id) {
    const u = state.usage[id];
    if (!u) return '<span class="muted">Loading usage…</span>';
    if (u.error) return `<span class="muted">${esc(u.error)}</span>`;
    return `<span class="usage-line">${meter(u.usedBytes, u.quotaBytes)}${fmtBytes(u.usedBytes)} of ${fmtBytes(u.quotaBytes)} · ${plural(u.sections, 'section')}</span>`;
  }

  function adminRequests(o) {
    if (!o.requests.length) return '<div class="empty"><h3>No requests yet</h3><p>Requests from the home page show up here.</p></div>';
    return `<div class="cards">${o.requests.map((r) => `
      <article class="rcard">
        <div class="rc-main">
          <div class="rc-title">${esc(r.name)} <span class="pill status-${esc(r.status)}">${esc(statusLabel(r.status))}</span></div>
          <div class="rc-sub"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.organization ? ` · ${esc(r.organization)}` : ''} · ${esc(ago(r.createdAt))}</div>
          <p class="rc-text">${esc(r.purpose)}</p>
          ${r.reason ? `<p class="rc-note">Reason given: ${esc(r.reason)}</p>` : ''}
          ${r.status === 'approved' ? `<p class="rc-note"><a href="#/${esc(r.spaceId)}">Open space</a> · ${r.userId ? 'owned by the requester’s account' : r.claimedAt ? 'requester collected the key' : 'key not collected yet'}</p>` : ''}
        </div>
        <div class="rc-actions">
          ${r.status === 'pending'
            ? `<button class="btn primary sm" data-action="approve" data-id="${esc(r.id)}">${I.check}Approve</button><button class="btn sm" data-action="reject" data-id="${esc(r.id)}">Reject</button>`
            : `<button class="btn ghost sm danger" data-action="delete-request" data-id="${esc(r.id)}" title="Delete this record and its personal data">${I.trash}Delete record</button>`}
        </div>
      </article>`).join('')}</div>`;
  }

  function adminSpaces(o) {
    if (!o.spaces.length) return `<div class="empty"><h3>No spaces yet</h3><p>Approve a request, or create a space yourself.</p><button class="btn primary" data-action="admin-new-space">${I.plus}New space</button></div>`;
    return `<div class="cards">${o.spaces.map((s) => `
      <article class="rcard">
        <div class="rc-main">
          <div class="rc-title">${esc(state.usage[s.id]?.title || s.title)}</div>
          <div class="rc-sub">${s.owner ? esc(s.owner) : 'No owner'}${s.email ? ` · <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : ''} · created ${esc(ago(s.createdAt))}</div>
          <div class="rc-usage">${usageLine(s.id)}</div>
        </div>
        <div class="rc-actions">
          <a class="btn sm" href="#/${esc(s.id)}">Open</a>
          <button class="btn sm" data-action="space-keys" data-id="${esc(s.id)}" title="Space key and review link (the key is only needed for spaces made before accounts)">${I.key}Keys</button>
          <button class="btn sm" data-action="space-quota" data-id="${esc(s.id)}">Storage</button>
          <button class="btn sm" data-action="space-rotate" data-id="${esc(s.id)}">New key</button>
          <button class="btn ghost sm danger" data-action="space-delete" data-id="${esc(s.id)}">${I.trash}Delete</button>
        </div>
      </article>`).join('')}</div>`;
  }

  function adminDemos(o) {
    const head = `<div class="tab-head"><p class="muted">Demo spaces are deleted automatically ${o.settings.demo.hours} hours after they start (checked hourly).</p><button class="btn sm" data-action="cleanup">Run cleanup now</button></div>`;
    if (!o.demos.length) return `${head}<div class="empty"><h3>No active demos</h3></div>`;
    return `${head}<div class="cards">${o.demos.map((d) => `
      <article class="rcard">
        <div class="rc-main">
          <div class="rc-title mono">${esc(d.id)}</div>
          <div class="rc-sub">Started ${esc(ago(d.createdAt))} · ends in ${esc(timeLeft(d.expiresAt))}</div>
          <div class="rc-usage">${usageLine(d.id)}</div>
        </div>
        <div class="rc-actions">
          <a class="btn sm" href="#/${esc(d.id)}">Open</a>
          <button class="btn ghost sm danger" data-action="space-delete" data-id="${esc(d.id)}">${I.trash}Delete</button>
        </div>
      </article>`).join('')}</div>`;
  }

  const ACTION_LABELS = {
    'request.create': 'requested a space', 'request.approve': 'approved a request', 'request.reject': 'rejected a request',
    'space.create': 'created a space', 'space.delete': 'deleted a space', 'space.claim': 'claimed a space with its key',
    'space.view_keys': 'viewed space keys', 'space.rotate_key': 'issued a new space key',
    'invite.create': 'sent an invite', 'invite.reviewer': 'emailed a review link', 'invite.accept': 'accepted an invite',
    'invite.revoke': 'cancelled an invite', 'invite.wrong_account': 'tried an invite meant for another address',
    'member.role': 'changed a member’s role', 'member.remove': 'removed a member', 'member.leave': 'left a space',
  };
  function adminActivity() {
    const a = state.audit;
    if (!a) return '<div class="empty"><p>Loading activity…</p></div>';
    if (a.error) return `<div class="empty"><p>${esc(a.error)}</p></div>`;
    if (!a.entries.length) return '<div class="empty"><h3>No activity yet</h3></div>';
    return `<p class="muted">The last 200 security-relevant actions. Entries are kept for a year.</p>
      <div class="rows">${a.entries.map((e) => `
        <div class="row-item"><div class="ri-main">
          <span class="ri-title">${esc(e.actor === 'anon' ? 'Someone (no account)' : e.actor)} ${esc(ACTION_LABELS[e.action] || e.action)}</span>
          <span class="ri-sub">${esc(ago(e.at))}${e.spaceId ? ` · <a href="#/${esc(e.spaceId)}">${esc(e.spaceId)}</a>` : ''}${e.detail?.role ? ` · ${esc(e.detail.role)}` : ''}${e.detail && 'emailed' in e.detail ? ` · ${e.detail.emailed ? 'emailed' : 'link only'}` : ''}</span>
        </div></div>`).join('')}</div>`;
  }

  // After the admin creates a space: the result, and the link to pass on if email didn't go out.
  function spaceCreated(k, line) {
    const link = `${SITE}#/${k.spaceId}`;
    const inviteLinkValue = k.invite?.link;
    const emailed = k.invite ? k.invite.emailed : k.emailed;
    const note = k.invite ? k.invite.emailNote : k.emailNote;
    modal({
      title: 'Space created',
      html: `<p>${line} ${emailed ? 'We emailed them.' : esc(note || '')}</p>
        ${inviteLinkValue ? copyField('Owner invite link (works only for their email address)', inviteLinkValue) : copyField('Space link', link)}
        ${copyField('Reviewer link', reviewLink(k.spaceId, k.reviewCode))}`,
      confirm: 'Done', cancel: false,
      onSubmit: () => {},
    });
  }

  function showKeys(k, { name = '', title = '' } = {}) {
    const open = `${SITE}#/${k.spaceId}`;
    const reviewer = reviewLink(k.spaceId, k.reviewCode);
    const message = `Hi${name ? ` ${name}` : ''},

Your Review Desk space${title ? ` "${title}"` : ''} is ready.

1. Open ${SITE} and paste your space key under "Have a key or link?":
   ${k.adminKey}
   Keep this key private: it gives full control of the space.

2. Share this link with your reviewers:
   ${reviewer}
`;
    modal({
      title: 'Space keys',
      html: `
        ${copyField('Space key (owner)', k.adminKey, { secret: true })}
        ${copyField('Reviewer link', reviewer)}
        ${copyField('Review code', k.reviewCode)}
        <div class="field"><label for="key-msg">Message to send the owner</label><textarea class="textarea mono sm-text" id="key-msg" rows="7" readonly>${esc(message)}</textarea></div>
        <p class="muted">Send the key over a private channel. <a href="${esc(open)}">Open the space</a></p>`,
      confirm: 'Copy message', cancelLabel: 'Done',
      onSubmit: async () => { await copyText(message); return false; },
    });
  }

  /* ------------------------------------------------------------------ share */
  async function loadMembers() {
    try {
      state.members = await api('GET', `/api/s/${spaceId()}/members`);
    } catch (e) {
      state.members = { error: e.message };
    }
    if ($('#share-dialog')) shareDialog();
  }

  // Share → Reviewers: the link (no account needed), or email it.
  // Share → Team: owners and editors, pending invites, invite by email.
  function shareDialog() {
    const tab = state.shareTab;
    const code = spaceCode();
    const link = reviewLink(spaceId(), code);
    const demo = state.project.space.kind === 'demo';
    const owner = !!state.me.owner;
    const res = state.shareResult;
    const result = res ? `<div class="share-result ${res.emailed ? 'ok' : ''}">
        <p>${res.emailed ? `${I.check}Sent to ${esc(res.email)}.` : esc(res.emailNote || '')}</p>
        ${res.emailed ? '' : copyField(res.kind === 'invite' ? 'Invite link (works only for that email address)' : 'Reviewer link', res.link)}
      </div>` : '';
    const needSignIn = `<p class="muted">${CLERK_KEY ? '<button type="button" class="link-btn" data-action="sign-in">Sign in</button> to send email invites.' : 'Email invites need sign-in, which isn’t set up on this site.'}</p>`;

    let body;
    if (tab === 'reviewers') {
      body = `<p>Anyone with this link can view the screenshots and comment. They don’t need an account.</p>
        ${copyField('Reviewer link', link)}
        ${copyField('Review code', code)}
        ${signedIn() ? `<div class="field"><label for="share-email">Email the link to a reviewer</label>
          <div class="cf-row"><input class="input" id="share-email" name="email" type="email" maxlength="200" placeholder="name@example.com" autocomplete="off">
          <button type="submit" class="btn sm" data-send="reviewer">${I.mail}Send</button></div></div>` : needSignIn}
        ${result}
        ${demo ? `<p class="muted">The link stops working when the demo ends, in ${timeLeft(state.project.space.expiresAt)}.</p>` : ''}
        <p class="muted">Need to cut off access? Use <b>New review code</b> in the ⋯ menu; old links stop working.</p>`;
    } else if (demo) {
      body = '<p>Demo spaces are for trying things out alone, so they can’t have editors. <button type="button" class="link-btn" data-action="request-space">Request a space</button> to work as a team.</p>';
    } else {
      const m = state.members;
      const you = m?.you;
      const rows = !m ? '<p class="muted">Loading…</p>' : m.error ? `<p class="err">${esc(m.error)}</p>` : `
        <div class="member-list">${m.members.map((x) => `
          <div class="member">
            ${avatar(x.name || x.email)}
            <div class="m-main"><b>${esc(x.name || x.email)}${x.id === you ? ' (you)' : ''}</b><span class="muted">${esc(x.email)}</span></div>
            <span class="pill">${x.role === 'owner' ? 'Owner' : 'Editor'}</span>
            ${owner && x.id !== you ? `<button type="button" class="link-btn" data-action="member-role" data-uid="${esc(x.id)}" data-role="${x.role === 'owner' ? 'editor' : 'owner'}">${x.role === 'owner' ? 'Make editor' : 'Make owner'}</button>
              <button type="button" class="link-btn danger" data-action="member-remove" data-uid="${esc(x.id)}">Remove</button>` : ''}
          </div>`).join('') || '<p class="muted">No members yet.</p>'}
        ${m.invites.map((i) => `
          <div class="member pending">
            <div class="avatar" aria-hidden="true">${I.mail}</div>
            <div class="m-main"><b>${esc(i.email)}</b><span class="muted">Invited ${esc(ago(i.createdAt))} · expires ${esc(ago(i.expiresAt))}</span></div>
            <span class="pill">${i.role === 'owner' ? 'Owner' : 'Editor'}</span>
            ${owner ? `<button type="button" class="link-btn danger" data-action="invite-revoke" data-iid="${esc(i.id)}">Cancel</button>` : ''}
          </div>`).join('')}</div>`;
      body = `<p>Owners and editors upload screenshots and manage feedback. Owners also manage the team.</p>
        ${rows}
        ${!signedIn() ? needSignIn : owner ? `<div class="field"><label for="share-email">Invite by email</label>
          <div class="cf-row"><input class="input" id="share-email" name="email" type="email" maxlength="200" placeholder="name@example.com" autocomplete="off">
          <select class="input role-select" name="role" aria-label="Role"><option value="editor">Editor</option><option value="owner">Owner</option></select>
          <button type="submit" class="btn sm" data-send="team">${I.mail}Invite</button></div>
          <small class="hint-text">They sign in with that email address to accept. Invites expire after 7 days.</small></div>` : '<p class="muted">Only owners can invite editors.</p>'}
        ${result}`;
    }

    modal({
      title: 'Share',
      animate: !$('#share-dialog'),
      html: `<div id="share-dialog"><div class="tabs sm" role="tablist">
          <button type="button" role="tab" class="tab ${tab === 'reviewers' ? 'active' : ''}" aria-selected="${tab === 'reviewers'}" data-action="share-tab" data-tab="reviewers">Reviewers</button>
          <button type="button" role="tab" class="tab ${tab === 'team' ? 'active' : ''}" aria-selected="${tab === 'team'}" data-action="share-tab" data-tab="team">Team</button>
        </div>${body}</div>`,
      confirm: tab === 'reviewers' ? 'Copy link' : 'Done', cancelLabel: 'Close', cancel: tab === 'reviewers',
      onSubmit: async (v, submitter) => {
        const kind = submitter?.dataset.send;
        if (!kind) {
          if (tab === 'reviewers') { await copyText(link); return false; }
          return;
        }
        const email = String(v.email || '').trim();
        if (!email) throw new Error('Enter an email address.');
        const r = await api('POST', `/api/s/${spaceId()}/invites`, { email, role: kind === 'reviewer' ? 'reviewer' : v.role });
        state.shareResult = { ...r, email };
        if (kind === 'team') state.members = await api('GET', `/api/s/${spaceId()}/members`);
        shareDialog();
        return false;
      },
    });
  }

  /* ------------------------------------------------------------------ modal */
  // onSubmit may return false to keep the modal open.
  // animate: false when redrawing a modal that is already open (e.g. switching tabs).
  function modal({ title, text = '', html = '', fields = [], confirm = 'Save', cancel = true, cancelLabel = 'Cancel', danger = false, animate = true, onSubmit }) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop${animate ? '' : ' still'}">
        <form class="modal" novalidate role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <h3 id="modal-title">${esc(title)}</h3>
          ${text ? `<p>${text}</p>` : ''}
          ${html}
          ${fields.map((f, i) => `<div class="field">
            <label for="mf-${i}">${esc(f.label)}</label>
            ${f.multiline
              ? `<textarea class="textarea" id="mf-${i}" name="${f.name}" maxlength="${f.max || 1000}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
              : `<input class="input" id="mf-${i}" name="${f.name}" type="${f.type || 'text'}" maxlength="${f.max || 200}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} ${f.type === 'number' ? 'inputmode="numeric" min="1"' : ''} autocomplete="${f.autocomplete || 'off'}">`}
            ${f.hint ? `<small class="hint-text">${f.hint}</small>` : ''}
          </div>`).join('')}
          <div class="err" hidden></div>
          <div class="row">
            ${cancel ? `<button type="button" class="btn ghost" data-close>${esc(cancelLabel)}</button>` : ''}
            <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(confirm)}</button>
          </div>
        </form>
      </div>`;
    const form = $('form', root);
    const close = () => { root.innerHTML = ''; };
    root.querySelector('[data-close]')?.addEventListener('click', close);
    root.querySelector('.modal-backdrop').onmousedown = (e) => { if (e.target === e.currentTarget) close(); };
    form.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const missing = fields.find((f) => f.required && !String(values[f.name] || '').trim());
      const err = $('.err', form);
      if (missing) { err.textContent = `${missing.label} is required.`; err.hidden = false; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const keep = await onSubmit(values, e.submitter);
        if (keep === false) btn.disabled = false; else if (root.contains(form)) close();
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false; btn.disabled = false;
      }
    };
    if (!coarse) (form.querySelector('input:not([readonly]),textarea:not([readonly])') || form.querySelector('[type=submit]')).focus();
  }
  const confirmBox = (title, text, confirm, onSubmit) => modal({ title, text, confirm, danger: true, onSubmit });

  /* ---------------------------------------------------------------- actions */
  const findReq = (id) => state.overview.requests.find((r) => r.id === id);

  const actions = {
    // navigation
    'open-section': (el) => go(el.dataset.sid),
    'open-image': (el) => go(currentSection().id, el.dataset.iid),
    'close-viewer': () => go(state.route.sid),
    'nav-image': (el) => navImage(Number(el.dataset.dir)),
    'reload': () => location.reload(),
    'refresh': () => load().then(() => toast('Up to date')),
    'menu': () => { state.menuOpen = state.menuOpen === 'space' ? false : 'space'; render(); },
    'copy': (el) => copyText(el.dataset.text),

    // home
    'start-demo': () => run(async () => {
      const d = await api('POST', '/api/demo', undefined, { space: null, headers: await humanCheck() });
      creds.set(d.spaceId, { key: d.adminKey, code: d.reviewCode, title: d.space.title, kind: 'demo', expiresAt: d.space.expiresAt });
      store.set('demo', d.spaceId);
      state.welcome = d.spaceId;
      nav(spaceHash(d.spaceId));
    }),
    'request-space': () => {
      if (!signedIn()) return signIn();
      const email = clerk.user.primaryEmailAddress?.emailAddress || '';
      modal({
        title: 'Request a space',
        text: `Tell us a little about your project. An admin reviews each request, and you become the owner of the space when it’s approved. We’ll email <b>${esc(email)}</b> about it.`,
        fields: [
          { name: 'organization', label: 'Company or team (optional)', max: 120, autocomplete: 'organization' },
          { name: 'purpose', label: 'What will you review?', multiline: true, max: 1000, required: true, placeholder: 'e.g. App redesign for a client, around 60 screens over two months' },
        ],
        confirm: 'Send request',
        onSubmit: async (v) => {
          await api('POST', '/api/requests', v, { space: null });
          await refreshAccount();
          nav('#/');
          render();
          toast('Request sent. You’ll see the result here.');
        },
      });
    },
    'check-request': () => openRequest(state.request.id),
    'drop-request': (el) => { saveRequests(myRequests().filter((r) => r.id !== el.dataset.id)); nav('#/'); },
    'forget-space': (el) => {
      const id = el.dataset.id;
      const c = creds.get(id);
      const doIt = () => { creds.forget(id); if (store.get('demo') === id) store.set('demo', null); if (state.route.view === 'space') nav('#/'); else render(); };
      if (c.key && c.kind !== 'demo') {
        confirmBox('Forget this space?', 'Your space key will be removed from this browser. Make sure you’ve saved it somewhere, or you won’t be able to manage the space.', 'Forget', doIt);
      } else doIt();
    },

    // account
    'sign-in': () => signIn(),
    'sign-out': () => { state.menuOpen = false; clerk?.signOut(); },
    'manage-account': () => { state.menuOpen = false; clerk?.openUserProfile(); },
    'account-menu': () => { state.menuOpen = state.menuOpen === 'account' ? false : 'account'; render(); },
    'accept-invite': () => run(async () => {
      const r = await api('POST', `/api/invites/${encodeURIComponent(session.get('invite') || '')}/accept`, {}, { space: null });
      session.set('invite', null);
      await refreshAccount();
      toast(`You’re now ${r.role === 'owner' ? 'an owner' : 'an editor'} of this space`);
      nav(spaceHash(r.spaceId));
    }),
    'claim-space': () => confirmBox('Make your account the owner?', 'Your account becomes an owner of this space, and the space key stops working for you and anyone else using it. Invite teammates from <b>Share → Team</b> afterwards.', 'Make me the owner', async () => {
      await api('POST', `/api/s/${spaceId()}/claim`, {});
      creds.set(spaceId(), { key: null });
      await refreshAccount();
      toast('This space is now on your account');
      openSpace(spaceId());
    }),
    'leave-space': () => confirmBox('Leave this space?', 'You lose access unless someone invites you again.', 'Leave', async () => {
      await api('DELETE', `/api/s/${spaceId()}/members/${encodeURIComponent(clerk.user.id)}`);
      await refreshAccount();
      nav('#/');
      toast('You left the space');
    }),

    // space
    'share': () => { state.shareResult = null; shareDialog(); },
    'share-tab': (el) => {
      state.shareTab = el.dataset.tab;
      state.shareResult = null;
      shareDialog();
      if (state.shareTab === 'team' && !state.members && state.project.space.kind !== 'demo') loadMembers();
    },
    'member-role': (el) => run(async () => {
      state.members = await api('PATCH', `/api/s/${spaceId()}/members/${encodeURIComponent(el.dataset.uid)}`, { role: el.dataset.role });
      shareDialog();
    }),
    'member-remove': (el) => run(async () => {
      state.members = await api('DELETE', `/api/s/${spaceId()}/members/${encodeURIComponent(el.dataset.uid)}`);
      shareDialog();
    }),
    'invite-revoke': (el) => run(async () => {
      state.members = await api('DELETE', `/api/s/${spaceId()}/invites/${encodeURIComponent(el.dataset.iid)}`);
      shareDialog();
    }),
    'rotate-code': () => confirmBox('Create a new review code?', 'Everyone using the current link or code loses access until you send them the new one.', 'New code', async () => {
      const r = await api('POST', `/api/s/${spaceId()}/rotate-code`);
      state.me.reviewCode = r.reviewCode;
      state.me.imageToken = r.imageToken;
      if (creds.get(spaceId()).key) creds.set(spaceId(), { code: r.reviewCode });
      state.menuOpen = false;
      render();
      actions.share();
    }),
    'owner-in': () => modal({
      title: 'Owner sign-in', text: 'Paste the space key you received when this space was created.',
      fields: [{ name: 'key', label: 'Space key', type: 'password', required: true, max: 200, placeholder: 'sk-…' }],
      confirm: 'Sign in',
      onSubmit: async ({ key }) => {
        key = key.trim();
        const m = key.match(KEY_RE);
        if (!m) throw new Error('That doesn’t look like a space key. It starts with “sk-”.');
        if (m[1] !== spaceId()) throw new Error('That key belongs to a different space.');
        const prev = creds.get(spaceId()).key || null;
        creds.set(spaceId(), { key });
        const me = await api('GET', `/api/s/${spaceId()}/me`).catch((e) => { creds.set(spaceId(), { key: prev }); throw e; });
        if (!me.admin) { creds.set(spaceId(), { key: prev }); throw new Error('That key is not correct.'); }
        state.me = me;
        creds.set(spaceId(), { code: me.reviewCode });
        state.menuOpen = false;
        render();
        toast('Signed in as owner');
      },
    }),
    'owner-out': () => { creds.set(spaceId(), { key: null }); state.menuOpen = false; openSpace(spaceId()); },
    'delete-demo': () => confirmBox('Delete this demo now?', 'All sections, screenshots and comments in this demo are deleted for everyone. This can’t be undone.', 'Delete demo', async () => {
      await api('DELETE', `/api/s/${spaceId()}`);
      creds.forget(spaceId());
      store.set('demo', null);
      nav('#/');
      toast('Demo deleted');
    }),
    'toggle-fit': () => { store.set('fit', store.get('fit') === '0' ? '1' : '0'); render(); },
    'toggle-resolved': (el) => { state.showResolved[el.dataset.target] = !state.showResolved[el.dataset.target]; render(); },
    'reply': (el) => { state.replyTo = el.dataset.cid; render(); document.querySelector('.reply-box textarea')?.focus(); },
    'cancel-reply': () => { state.replyTo = null; render(); },
    'clear-pin': () => { state.pinDraft = null; render(); },
    'focus-comment': (el) => {
      const t = document.querySelector(`.thread[data-cid="${el.dataset.cid}"]`);
      if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); setHighlight(el.dataset.cid); }
    },
    'copy-link': (el) => copyText(reviewLink(spaceId(), spaceCode(), `/s/${el.dataset.sid}${el.dataset.iid ? `/i/${el.dataset.iid}` : ''}`)),
    'change-name': () => modal({
      title: 'Your name', text: 'Shown next to the comments you post.',
      fields: [{ name: 'name', label: 'Name', value: state.name, required: true, max: 60, autocomplete: 'name' }],
      onSubmit: ({ name }) => { setName(name); state.menuOpen = false; render(); },
    }),
    'rename-project': () => modal({
      title: 'Rename space', fields: [{ name: 'title', label: 'Space name', value: state.project.title, required: true, max: 120 }],
      onSubmit: async ({ title }) => {
        state.project = await api('PATCH', `/api/s/${spaceId()}/project`, { title });
        document.title = `${state.project.title} · Review Desk`;
        if (creds.get(spaceId()).key) creds.set(spaceId(), { title: state.project.title });
        render();
      },
    }),
    'new-section': () => modal({
      title: 'New section', text: 'A section groups related screenshots — a feature, a flow or a screen.',
      fields: [
        { name: 'title', label: 'Title', placeholder: 'e.g. Rider sign-up', required: true, max: 120 },
        { name: 'description', label: 'Description (optional)', placeholder: 'What should reviewers focus on?', multiline: true },
      ],
      confirm: 'Create',
      onSubmit: async (v) => { const s = await api('POST', `/api/s/${spaceId()}/sections`, v); applySection(s); go(s.id); },
    }),
    'edit-section': () => {
      const s = currentSection();
      modal({
        title: 'Edit section',
        fields: [
          { name: 'title', label: 'Title', value: s.title, required: true, max: 120 },
          { name: 'description', label: 'Description', value: s.description, multiline: true },
        ],
        onSubmit: async (v) => { applySection(await api('PATCH', `/api/s/${spaceId()}/sections/${s.id}`, v)); render(); },
      });
    },
    'delete-section': () => {
      const s = currentSection();
      confirmBox('Delete section?', `“${esc(s.title)}”, its ${plural(s.images.length, 'screenshot')} and ${plural(s.comments.length, 'comment')} will be removed.`, 'Delete section', async () => {
        await api('DELETE', `/api/s/${spaceId()}/sections/${s.id}`);
        state.project.sections = state.project.sections.filter((x) => x.id !== s.id);
        go(state.project.sections[0]?.id || null);
        toast('Section deleted');
      });
    },
    'edit-caption': () => {
      const s = currentSection();
      const img = s.images.find((i) => i.id === state.route.iid);
      modal({
        title: 'Edit caption', fields: [{ name: 'caption', label: 'Caption', value: img.caption, placeholder: img.name, max: 200 }],
        onSubmit: async (v) => { applySection(await api('PATCH', `/api/s/${spaceId()}/sections/${s.id}/images/${img.id}`, v)); render(); },
      });
    },
    'delete-image': () => {
      const s = currentSection();
      const img = s.images.find((i) => i.id === state.route.iid);
      const n = s.comments.filter((c) => c.target === img.id).length;
      confirmBox('Delete screenshot?', `This removes the screenshot${n ? ` and its ${plural(n, 'comment')}` : ''}.`, 'Delete', async () => {
        const idx = s.images.indexOf(img);
        applySection(await api('DELETE', `/api/s/${spaceId()}/sections/${s.id}/images/${img.id}`));
        const next = currentSection().images[Math.min(idx, currentSection().images.length - 1)];
        go(s.id, next?.id);
      });
    },
    'resolve': (el) => run(async () => {
      applySection(await api('PATCH', `/api/s/${spaceId()}/sections/${currentSection().id}/comments/${el.dataset.cid}`, { resolved: el.dataset.val === '1' }));
      render();
    }),
    'delete-comment': (el) => confirmBox('Delete comment?', 'Replies to it are deleted too.', 'Delete', async () => {
      applySection(await api('DELETE', `/api/s/${spaceId()}/sections/${currentSection().id}/comments/${el.dataset.cid}`));
      render();
    }),
    'pick-files': () => $('#file-input')?.click(),

    // site admin
    'admin-tab': (el) => {
      state.adminTab = el.dataset.tab;
      render();
      if (state.adminTab === 'activity') loadAudit();
    },
    'admin-refresh': () => openAdmin(),
    'approve': (el) => {
      const r = findReq(el.dataset.id);
      modal({
        title: `Approve ${r.name}’s request`,
        text: r.userId
          ? `This creates the space and makes <b>${esc(r.email)}</b> its owner. They get an email if email is set up.`
          : 'This request was made before accounts: you’ll get a space key to pass on, and the requester can collect it once from their status page.',
        fields: [
          { name: 'title', label: 'Space name', value: r.organization || `${r.name}’s space`, required: true, max: 120 },
          { name: 'quotaMb', label: 'Storage (MB)', type: 'number', value: Math.round(state.overview.settings.spaceQuotaBytes / 1048576), required: true, max: 6 },
        ],
        confirm: 'Approve',
        onSubmit: async (v) => {
          const k = await api('POST', `/api/admin/requests/${r.id}/approve`, v, { space: null });
          await openAdmin();
          if (k.legacy) showKeys(k, { name: r.name, title: v.title });
          else spaceCreated(k, `${esc(r.email)} is the owner.`);
          return false;
        },
      });
    },
    'reject': (el) => {
      const r = findReq(el.dataset.id);
      modal({
        title: `Reject ${r.name}’s request?`,
        fields: [{ name: 'reason', label: 'Reason (optional, shown to the requester)', multiline: true, max: 500 }],
        confirm: 'Reject', danger: true,
        onSubmit: async (v) => { await api('POST', `/api/admin/requests/${r.id}/reject`, v, { space: null }); await openAdmin(); },
      });
    },
    'delete-request': (el) => confirmBox('Delete this request record?', 'The requester’s name, email and message are removed. An approved space is not affected.', 'Delete record', async () => {
      await api('DELETE', `/api/admin/requests/${el.dataset.id}`, undefined, { space: null });
      await openAdmin();
    }),
    'admin-new-space': () => modal({
      title: 'New space', text: 'Create a space directly, without a request.',
      fields: [
        { name: 'title', label: 'Space name', required: true, max: 120 },
        { name: 'email', label: 'Owner’s email (optional)', type: 'email', max: 200, hint: 'They get an invite to become the owner.' },
        { name: 'quotaMb', label: 'Storage (MB)', type: 'number', value: Math.round((state.overview?.settings.spaceQuotaBytes || 209715200) / 1048576), required: true, max: 6 },
      ],
      confirm: 'Create',
      onSubmit: async (v) => {
        const k = await api('POST', '/api/admin/spaces', v, { space: null });
        state.adminTab = 'spaces';
        await openAdmin();
        spaceCreated(k, k.invite ? `An owner invite went to ${esc(v.email)}.` : 'It has no owner yet: open it and invite one from Share → Team.');
        return false;
      },
    }),
    'space-keys': (el) => run(async () => {
      const k = await api('GET', `/api/admin/spaces/${el.dataset.id}/keys`, undefined, { space: null });
      const s = state.overview.spaces.find((x) => x.id === el.dataset.id);
      showKeys(k, { name: s?.owner, title: s?.title });
    }),
    'space-quota': (el) => {
      const u = state.usage[el.dataset.id];
      modal({
        title: 'Change storage',
        text: u && !u.error ? `Currently ${fmtBytes(u.usedBytes)} of ${fmtBytes(u.quotaBytes)} used.` : '',
        fields: [{ name: 'quotaMb', label: 'Storage (MB)', type: 'number', value: u?.quotaBytes ? Math.round(u.quotaBytes / 1048576) : '', required: true, max: 6 }],
        onSubmit: async (v) => {
          state.usage[el.dataset.id] = await api('PATCH', `/api/admin/spaces/${el.dataset.id}`, v, { space: null });
          render();
        },
      });
    },
    'space-rotate': (el) => confirmBox('Issue a new space key?', 'The current key stops working within a minute. You’ll need to send the new key to the owner.', 'New key', async () => {
      const k = await api('POST', `/api/admin/spaces/${el.dataset.id}/rotate-key`, undefined, { space: null });
      const s = state.overview.spaces.find((x) => x.id === el.dataset.id);
      showKeys(k, { name: s?.owner, title: s?.title });
      return false;
    }),
    'space-delete': (el) => {
      const id = el.dataset.id;
      const title = state.usage[id]?.title || state.overview.spaces.find((x) => x.id === id)?.title || id;
      confirmBox('Delete this space?', `“${esc(title)}” and all its screenshots and comments are deleted for everyone. This can’t be undone from here.`, 'Delete space', async () => {
        await api('DELETE', `/api/admin/spaces/${id}`, undefined, { space: null });
        creds.forget(id);
        await openAdmin();
        toast('Space deleted');
      });
    },
    'cleanup': () => run(async () => {
      const r = await api('POST', '/api/admin/cleanup', undefined, { space: null });
      await openAdmin();
      toast(r.removedSpaces ? `Removed ${plural(r.removedSpaces, 'expired demo')}` : 'Nothing to clean up');
    }),
  };

  function setName(name) {
    state.name = String(name).trim().slice(0, 60);
    store.set('name', state.name);
  }

  function navImage(dir) {
    const s = currentSection();
    const idx = s.images.findIndex((i) => i.id === state.route.iid);
    const next = s.images[idx + dir];
    if (next) go(s.id, next.id);
  }

  function setHighlight(cid) {
    if (state.highlight === cid) return;
    state.highlight = cid;
    document.querySelectorAll('.thread.hl, .pin.hl').forEach((el) => el.classList.remove('hl'));
    if (cid) document.querySelectorAll(`.thread[data-cid="${cid}"], .pin[data-cid="${cid}"]`).forEach((el) => el.classList.add('hl'));
  }

  async function postComment(form) {
    const s = currentSection();
    const key = form.dataset.key;
    const text = state.drafts[key]?.trim() || form.querySelector('textarea').value.trim();
    const nameInput = form.querySelector('[name=author]');
    if (nameInput && !signedIn()) {
      if (!nameInput.value.trim()) { nameInput.focus(); return toast('Please add your name so the team knows who commented', 'error'); }
      setName(nameInput.value);
    }
    if (!text) return;
    const target = form.dataset.target;
    const parentId = form.dataset.parent || null;
    const body = { author: state.name, text, target, parentId };
    if (!parentId && target !== 'section' && state.pinDraft) body.pin = state.pinDraft;

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const ok = await run(async () => {
      applySection(await api('POST', `/api/s/${spaceId()}/sections/${s.id}/comments`, body));
      return true;
    });
    btn.disabled = false;
    if (ok) {
      delete state.drafts[key];
      if (parentId) state.replyTo = null; else state.pinDraft = null;
      render();
      const list = document.querySelector('.panel-scroll');
      if (list && !parentId) list.scrollTop = list.scrollHeight;
    } else {
      render();
    }
  }

  /* ---------------------------------------------------------------- uploads */
  async function uploadFiles(files) {
    const s = currentSection();
    if (!s || !isAdmin()) return;
    const images = [...files].filter((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type));
    if (!images.length) return toast('Only PNG, JPG, GIF or WebP images can be uploaded', 'error');
    let done = 0;
    const t = toast(`Uploading 1 of ${images.length}…`);
    for (const file of images) {
      t.textContent = `Uploading ${done + 1} of ${images.length}…`;
      const left = state.project.space.quotaBytes - usedBytes();
      if (file.size > MAX_UPLOAD) { toast(`${file.name} is over 15 MB — skipped`, 'error'); continue; }
      if (file.size > left) { toast(`${file.name} (${fmtBytes(file.size)}) doesn’t fit: ${fmtBytes(Math.max(0, left))} of storage left`, 'error'); continue; }
      try {
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('Could not read file'));
          r.readAsDataURL(file);
        });
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[file.type];
        const filename = /\.[a-z0-9]+$/i.test(file.name) ? file.name : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
        applySection(await api('POST', `/api/s/${spaceId()}/sections/${s.id}/images`, { filename, data }));
        done++;
        render();
      } catch (e) {
        toast(`${file.name}: ${e.message}`, 'error');
      }
    }
    t.remove();
    if (done) toast(`${plural(done, 'screenshot')} uploaded`);
  }

  /* ----------------------------------------------------------------- events */
  document.addEventListener('click', (e) => {
    if (state.menuOpen && !e.target.closest('.menu-wrap')) { state.menuOpen = false; render(); }
    const el = e.target.closest('[data-action]');
    if (el && el.tagName !== 'FORM' && actions[el.dataset.action]) {
      e.preventDefault();
      if (el.closest('.menu')) { state.menuOpen = false; $('.menu')?.remove(); }
      actions[el.dataset.action](el);
      return;
    }
    if (e.target.closest('.menu a')) { state.menuOpen = false; return; }
    // Click on the screenshot drops a pin.
    const canvas = e.target.closest('#canvas');
    if (canvas && e.target.tagName === 'IMG') {
      const r = e.target.getBoundingClientRect();
      state.pinDraft = {
        x: Math.round(((e.clientX - r.left) / r.width) * 10000) / 100,
        y: Math.round(((e.clientY - r.top) / r.height) * 10000) / 100,
      };
      state.replyTo = null;
      render();
      const ta = document.querySelector('.panel-foot textarea');
      if (ta) { ta.focus({ preventScroll: true }); if (coarse) ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-action="post"]');
    if (form) { e.preventDefault(); postComment(form); return; }
    if (e.target.matches('[data-form="open"]')) { e.preventDefault(); openFromInput(e.target.value.value); }
  });

  document.addEventListener('input', (e) => {
    if (e.target.dataset.draft) state.drafts[e.target.dataset.draft] = e.target.value;
  });

  // Select the whole value of a copy field on focus, so it's easy to copy by hand.
  document.addEventListener('focusin', (e) => { if (e.target.matches?.('.copy-field input')) e.target.select(); });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches?.('textarea[data-draft]') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.target.form.requestSubmit();
      return;
    }
    if (e.key === 'Escape' && state.menuOpen) { state.menuOpen = false; render(); return; }
    if ($('#modal-root').innerHTML || !state.route.iid) return;
    if (e.target.matches?.('input, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') { state.pinDraft ? actions['clear-pin']() : go(state.route.sid); }
    if (e.key === 'ArrowLeft') navImage(-1);
    if (e.key === 'ArrowRight') navImage(1);
  });

  document.addEventListener('mouseover', (e) => {
    if (coarse) return;
    const el = e.target.closest('.thread[data-cid], .pin[data-cid]');
    setHighlight(el ? el.dataset.cid : null);
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'file-input') { uploadFiles(e.target.files); e.target.value = ''; }
  });

  document.addEventListener('dragover', (e) => {
    const dz = $('#dropzone');
    if (!dz || state.route.iid || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dz.classList.add('over');
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#dropzone')?.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    const dz = $('#dropzone');
    if (!dz || state.route.iid || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    dz.classList.remove('over');
    uploadFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    if (!isAdmin() || state.route.view !== 'space' || state.route.iid || e.target.matches?.('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });

  // Pick up other people's comments when someone returns to the tab.
  document.addEventListener('visibilitychange', () => {
    const typing = document.activeElement?.matches?.('textarea, input');
    if (document.visibilityState === 'visible' && state.project && !typing && Date.now() - state.lastLoad > 60_000) load({ quiet: true });
  });

  /* ------------------------------------------------------------------- boot */
  function boot() {
    if (!API || API.includes('YOUR-SUBDOMAIN')) {
      $('#app').innerHTML = '<div class="boot">Set <code>apiUrl</code> in <code>config.js</code> to your Cloudflare Worker URL, then reload.</div>';
      return;
    }
    // A review code can be shared in the link: …/?code=XYZ#/<space>
    const params = new URLSearchParams(location.search);
    const urlCode = params.get('code');
    const r = parseRoute();
    if (urlCode && r.view === 'space') creds.set(r.space, { code: urlCode });
    if (urlCode || params.has('admin')) {
      const toAdmin = params.has('admin');
      params.delete('code');
      params.delete('admin');
      const qs = params.toString(); // anything else (e.g. Clerk's) stays
      history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + (toAdmin ? '#/admin' : location.hash));
    }
    api('GET', '/api/config', undefined, { space: null })
      .then((c) => { state.config = c; if (state.route.view === 'home') render(); })
      .catch(() => {});
    route();
  }

  boot();
})();
