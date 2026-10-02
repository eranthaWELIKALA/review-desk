/* Review Desk — static front end for GitHub Pages.
 * All reads/writes go through the Worker in config.js; nothing secret lives here.
 *
 * Routes (hash):
 *   #/                     home: try a demo, request a space, open one
 *   #/admin                site admin console
 *   #/r/<id>[/<token>]     status of a space request
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

  // The site admin session (never the admin key itself) lives only in this tab's
  // sessionStorage, so it is gone when the tab closes and expires within an hour.
  const session = {
    get(k) { try { return sessionStorage.getItem('rd:' + k); } catch { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem('rd:' + k) : sessionStorage.setItem('rd:' + k, v); } catch { /* private mode */ } },
  };
  store.set('siteKey', null);   // purge the raw key older versions kept in localStorage
  session.set('siteKey', null); // …and in sessionStorage
  // Admin sessions look like as.<expiry, base 36>.<mac>.
  const sessionExpiry = (t) => parseInt(String(t || '').split('.')[1] || '0', 36) || 0;

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
    siteSession: session.get('siteSession') || '',
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

  /* -------------------------------------------------------------------- api */
  async function api(method, path, body, { space = spaceId(), headers: extra = {} } = {}) {
    const headers = { ...extra };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.siteSession) headers['X-Admin-Session'] = state.siteSession;
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
    if (r.view === 'request') return openRequest(r.rid, r.token);
    document.title = 'Review Desk';
    return render();
  }

  function render() {
    const v = state.route.view;
    if (v === 'space') return renderSpace();
    if (v === 'admin') return renderAdmin();
    if (v === 'request') return renderRequest();
    return renderHome();
  }

  /* ------------------------------------------------------------- page bits */
  const brand = (label = 'Review Desk') => `<a class="brand" href="#/" title="Review Desk home"><div class="brand-mark">${I.logo}</div><span>${esc(label)}</span></a>`;

  function page(inner) {
    $('#app').innerHTML = `<header class="topbar">${brand()}<div class="spacer"></div></header><main class="page">${inner}</main>`;
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

    const spaces = Object.entries(creds.all())
      .filter(([id, c]) => (c.key || c.code) && !(c.kind === 'demo' && c.expiresAt && Date.parse(c.expiresAt) < Date.now()) && SPACE_RE.test(id))
      .sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0));
    const reqs = myRequests();

    $('#app').innerHTML = `
      <header class="topbar">${brand()}<div class="spacer"></div>
        <button class="btn ghost sm" data-action="request-space">Request a space</button>
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
            <p>For real projects: ${cfg ? fmtBytes(cfg.spaceQuotaBytes) : 'more'} of storage and nothing expires. Tell us what it’s for and an admin will set it up.</p>
            <div class="option-foot"><button class="btn" data-action="request-space">Request a space</button></div>
          </article>
          <article class="option">
            <div class="option-icon">${I.key}</div>
            <h2>Have a key or link?</h2>
            <p>Paste your space key, or a review link someone sent you.</p>
            <form class="option-foot open-form" data-form="open">
              <label class="sr-only" for="open-value">Space key or review link</label>
              <input class="input" id="open-value" name="value" placeholder="sk-… or https://…" autocomplete="off" autocapitalize="off" spellcheck="false" required>
              <button class="btn" type="submit">Open</button>
            </form>
          </article>
        </div>

        ${spaces.length ? `<section class="list-block">
          <h3>On this device</h3>
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
          <h3>Your space requests</h3>
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
        <h1>${asOwner ? 'Owner sign-in' : 'Enter the review code'}</h1>
        <p>${asOwner ? 'Paste the space key you received when the space was created.' : 'You should have received it with the link to this page.'}${demo && info.expiresAt ? ` This demo space ends in ${timeLeft(info.expiresAt)}.` : ''}</p>
        <div class="field">
          <label for="gate-value">${asOwner ? 'Space key' : 'Review code'}</label>
          <input class="input ${asOwner ? 'mono' : 'code-input'}" id="gate-value" ${asOwner ? 'type="password" placeholder="sk-…"' : 'placeholder="ABCD-EFGH-JKMN" autocapitalize="characters"'} autocomplete="off" spellcheck="false" required>
        </div>
        ${message ? `<div class="err">${esc(message)}</div>` : ''}
        <div class="row">
          <button type="button" class="link-btn" id="gate-switch">${asOwner ? 'I have a review code' : 'I own this space'}</button>
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
        ${admin ? `<button class="btn primary sm" data-action="share" title="Invite reviewers">${I.share}<span class="hide-xs">Share</span></button>` : ''}
        <div class="menu-wrap">
          <button class="btn ghost sm icon" data-action="menu" aria-haspopup="menu" aria-expanded="${state.menuOpen}" title="More" aria-label="More options">${I.dots}</button>
          ${state.menuOpen ? spaceMenu() : ''}
        </div>
      </header>`;
  }

  function spaceMenu() {
    const admin = isAdmin();
    const c = creds.get(spaceId());
    const demo = state.project.space.kind === 'demo';
    const role = state.me.siteAdmin && !c.key ? 'Site admin' : admin ? 'Owner' : 'Reviewer';
    return `<div class="menu" role="menu">
      <div class="menu-head">${esc(role)}${state.name ? ` · ${esc(state.name)}` : ''}</div>
      <button role="menuitem" data-action="change-name">${state.name ? 'Change your name' : 'Set your name'}</button>
      ${admin ? '<button role="menuitem" data-action="rotate-code">New review code…</button>' : ''}
      ${!admin ? '<button role="menuitem" data-action="owner-in">Owner sign-in…</button>' : ''}
      ${admin && c.key ? '<button role="menuitem" data-action="owner-out">Sign out as owner</button>' : ''}
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
    if (!isAdmin()) return '';
    return `<div class="strip"><span class="strip-usage">Storage ${meter(used, s.quotaBytes)}${fmtBytes(used)} of ${fmtBytes(s.quotaBytes)}</span></div>`;
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
          <span class="who">${esc(c.author)}</span>
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
        ${state.name
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
    if (!state.siteSession || sessionExpiry(state.siteSession) <= Date.now()) {
      const expired = !!state.siteSession;
      adminSignOut();
      return adminGate(expired ? 'Your admin session ended. Please sign in again.' : '');
    }
    loading();
    try {
      state.overview = await api('GET', '/api/admin/overview', undefined, { space: null });
    } catch (e) {
      if (e.status === 403) { adminSignOut(); return adminGate('Your admin session ended. Please sign in again.'); }
      return notice({ title: 'Can’t load the admin console', text: esc(e.message), actions: '<button class="btn" data-action="reload">Try again</button>' });
    }
    state.usage = {};
    render();
    loadUsage();
  }

  function adminSignOut() {
    state.siteSession = '';
    session.set('siteSession', null);
  }

  // The admin key is sent once and exchanged for a one-hour session; only the session is kept.
  async function adminGate(message = '') {
    if (!state.config) state.config = await api('GET', '/api/config', undefined, { space: null }).catch(() => null);
    const otp = !!state.config?.adminOtp;
    page(`
      <form class="card-form" id="admin-form" novalidate>
        <h1>Site admin</h1>
        <p>Approve space requests and manage every space. Enter the <code>ADMIN_KEY</code> set on the Worker${otp ? ' and the code from your authenticator app' : ''}. You stay signed in for an hour, in this tab only.</p>
        <div class="field"><label for="admin-key">Admin key</label><input class="input mono" id="admin-key" type="password" autocomplete="current-password" required></div>
        ${otp ? '<div class="field"><label for="admin-otp">Authenticator code</label><input class="input mono" id="admin-otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div>' : ''}
        <div class="err" id="admin-err" ${message ? '' : 'hidden'}>${esc(message)}</div>
        <div class="row"><a class="btn ghost" href="#/">Cancel</a><button class="btn primary" type="submit">Sign in</button></div>
      </form>`);
    $('#admin-key').focus();
    $('#admin-form').onsubmit = async (e) => {
      e.preventDefault();
      const key = $('#admin-key').value.trim();
      if (!key) return;
      const btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/admin/session', { key, otp: $('#admin-otp')?.value.trim() || undefined }, { space: null });
        state.siteSession = r.session;
        session.set('siteSession', r.session);
        openAdmin();
      } catch (err) {
        $('#admin-err').hidden = false;
        $('#admin-err').textContent = err.message;
        btn.disabled = false;
      }
    };
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
    const tabs = [['requests', 'Requests', pending], ['spaces', 'Spaces', o.spaces.length], ['demos', 'Demos', o.demos.length]];
    const body = tab === 'spaces' ? adminSpaces(o) : tab === 'demos' ? adminDemos(o) : adminRequests(o);

    $('#app').innerHTML = `
      <header class="topbar">${brand()}<span class="chip admin hide-xs">Site admin</span><div class="spacer"></div>
        <button class="btn ghost sm" data-action="admin-refresh" aria-label="Refresh">${I.refresh}<span class="hide-sm">Refresh</span></button>
        <button class="btn primary sm" data-action="admin-new-space">${I.plus}<span class="hide-xs">New space</span></button>
        <button class="btn ghost sm" data-action="admin-out">Sign out</button>
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
          ${r.status === 'approved' ? `<p class="rc-note"><a href="#/${esc(r.spaceId)}">Open space</a> · ${r.claimedAt ? 'requester collected the key' : 'key not collected yet'}</p>` : ''}
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
          <button class="btn sm" data-action="space-keys" data-id="${esc(s.id)}">${I.key}Keys</button>
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

  /* ------------------------------------------------------------------ modal */
  // onSubmit may return false to keep the modal open.
  function modal({ title, text = '', html = '', fields = [], confirm = 'Save', cancel = true, cancelLabel = 'Cancel', danger = false, onSubmit }) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
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
        const keep = await onSubmit(values);
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
    'menu': () => { state.menuOpen = !state.menuOpen; render(); },
    'copy': (el) => copyText(el.dataset.text),

    // home
    'start-demo': () => run(async () => {
      const d = await api('POST', '/api/demo', undefined, { space: null, headers: await humanCheck() });
      creds.set(d.spaceId, { key: d.adminKey, code: d.reviewCode, title: d.space.title, kind: 'demo', expiresAt: d.space.expiresAt });
      store.set('demo', d.spaceId);
      state.welcome = d.spaceId;
      nav(spaceHash(d.spaceId));
    }),
    'request-space': () => modal({
      title: 'Request a space',
      text: 'Tell us a little about your project. An admin reviews each request; this browser gets a status page that shows your space key once it’s approved.',
      fields: [
        { name: 'name', label: 'Your name', required: true, max: 80, autocomplete: 'name' },
        { name: 'email', label: 'Email', type: 'email', required: true, max: 200, autocomplete: 'email', hint: 'Only used to contact you about this request.' },
        { name: 'organization', label: 'Company or team (optional)', max: 120, autocomplete: 'organization' },
        { name: 'purpose', label: 'What will you review?', multiline: true, max: 1000, required: true, placeholder: 'e.g. App redesign for a client, around 60 screens over two months' },
      ],
      confirm: 'Send request',
      onSubmit: async (v) => {
        const r = await api('POST', '/api/requests', v, { space: null, headers: await humanCheck() });
        saveRequests([...myRequests(), { id: r.id, token: r.token, createdAt: new Date().toISOString(), lastStatus: 'pending' }]);
        nav(`#/r/${r.id}`);
      },
    }),
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

    // space
    'share': () => {
      const code = spaceCode();
      const demo = state.project.space.kind === 'demo';
      modal({
        title: 'Invite reviewers',
        html: `<p>Anyone with this link can view the screenshots and comment. They don’t need an account.</p>
          ${copyField('Reviewer link', reviewLink(spaceId(), code))}
          ${copyField('Review code', code)}
          ${demo ? `<p class="muted">The link stops working when the demo ends, in ${timeLeft(state.project.space.expiresAt)}.</p>` : ''}
          <p class="muted">Need to cut off access? Use <b>New review code</b> in the ⋯ menu; old links stop working.</p>`,
        confirm: 'Copy link', cancelLabel: 'Close',
        onSubmit: async () => { await copyText(reviewLink(spaceId(), code)); return false; },
      });
    },
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
    'admin-tab': (el) => { state.adminTab = el.dataset.tab; render(); },
    'admin-refresh': () => openAdmin(),
    'admin-out': () => { adminSignOut(); nav('#/'); },
    'approve': (el) => {
      const r = findReq(el.dataset.id);
      modal({
        title: `Approve ${r.name}’s request`,
        text: 'This creates their space. You’ll see the keys next; the requester can also collect them once from their status page.',
        fields: [
          { name: 'title', label: 'Space name', value: r.organization || `${r.name}’s space`, required: true, max: 120 },
          { name: 'quotaMb', label: 'Storage (MB)', type: 'number', value: Math.round(state.overview.settings.spaceQuotaBytes / 1048576), required: true, max: 6 },
        ],
        confirm: 'Approve',
        onSubmit: async (v) => {
          const k = await api('POST', `/api/admin/requests/${r.id}/approve`, v, { space: null });
          await openAdmin();
          showKeys(k, { name: r.name, title: v.title });
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
        { name: 'owner', label: 'Owner name (optional)', max: 80 },
        { name: 'email', label: 'Owner email (optional)', type: 'email', max: 200 },
        { name: 'quotaMb', label: 'Storage (MB)', type: 'number', value: Math.round((state.overview?.settings.spaceQuotaBytes || 209715200) / 1048576), required: true, max: 6 },
      ],
      confirm: 'Create',
      onSubmit: async (v) => {
        const k = await api('POST', '/api/admin/spaces', v, { space: null });
        state.adminTab = 'spaces';
        await openAdmin();
        showKeys(k, { name: v.owner, title: v.title });
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
    if (nameInput) {
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
      history.replaceState(null, '', location.pathname + (params.has('admin') ? '#/admin' : location.hash));
    }
    api('GET', '/api/config', undefined, { space: null })
      .then((c) => { state.config = c; if (state.route.view === 'home') render(); })
      .catch(() => {});
    route();
  }

  boot();
})();
