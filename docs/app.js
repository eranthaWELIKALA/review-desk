/* Screenshot Review — static front end for GitHub Pages.
 * All reads/writes go through the Worker in config.js; nothing secret lives here. */
(() => {
  'use strict';

  const API = String((window.REVIEW_CONFIG || {}).apiUrl || '').replace(/\/+$/, '');
  const MAX_UPLOAD = 15 * 1024 * 1024;

  /* ---------------------------------------------------------------- storage */
  const store = {
    get(k) { try { return localStorage.getItem('sr:' + k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('sr:' + k) : localStorage.setItem('sr:' + k, v); } catch { /* private mode */ } },
  };

  /* ------------------------------------------------------------------ state */
  const state = {
    me: null,
    project: null,
    code: store.get('code') || '',
    adminKey: store.get('adminKey') || '',
    name: store.get('name') || '',
    route: { sid: null, iid: null },
    drafts: {},          // composer text, keyed by draft id
    replyTo: null,       // comment id currently being replied to
    pinDraft: null,      // { x, y } on the open screenshot
    showResolved: {},    // target id -> bool
    highlight: null,     // comment id hovered
    lastLoad: 0,
    busy: false,
  };

  /* ------------------------------------------------------------------- icons */
  const I = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><rect x="3" y="5" width="15" height="12"/><circle cx="18" cy="17" r="3.4" fill="currentColor" stroke="none"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  };

  /* ---------------------------------------------------------------- helpers */
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAdmin = () => !!state.me?.admin;

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function ago(iso) {
    const s = (new Date(iso) - Date.now()) / 1000;
    const steps = [[60, 'second'], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400]];
    if (Math.abs(s) < 45) return 'just now';
    for (const [lim, unit, div = 1] of steps) if (Math.abs(s) < lim) return rtf.format(Math.round(s / div), unit);
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function avatar(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const initials = name.trim().split(/\s+/).map((w) => [...w][0]).slice(0, 2).join('').toUpperCase();
    return `<div class="avatar" style="background:hsl(${h % 360} 45% 46%)" aria-hidden="true">${esc(initials)}</div>`;
  }
  function imageUrl(img) {
    if (state.me?.imageBase) return state.me.imageBase + img.path.split('/').map(encodeURIComponent).join('/');
    const q = state.code ? `?code=${encodeURIComponent(state.code)}` : '';
    return `${API}/img/${img.path.split('/').map(encodeURIComponent).join('/')}${q}`;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
    return el;
  }

  /* -------------------------------------------------------------------- api */
  async function api(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.code) headers['X-Review-Code'] = state.code;
    if (state.adminKey) headers['X-Admin-Key'] = state.adminKey;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('Could not reach the review server. Check your connection and the apiUrl in config.js.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Mutations return the updated section; patch it into local state.
  function applySection(section) {
    const list = state.project.sections;
    const i = list.findIndex((s) => s.id === section.id);
    if (i === -1) list.push(section); else list[i] = section;
  }

  async function load({ quiet = false } = {}) {
    try {
      state.project = await api('GET', '/api/project');
      state.lastLoad = Date.now();
      document.title = state.project.title;
      render();
    } catch (e) {
      if (e.status === 401) { state.code = ''; store.set('code', null); return boot(); }
      if (!quiet) toast(e.message, 'error');
    }
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
    const m = location.hash.match(/^#\/s\/([a-z0-9]+)(?:\/i\/([a-z0-9]+))?/);
    state.route = { sid: m?.[1] || null, iid: m?.[2] || null };
  }
  function go(sid, iid) {
    const hash = sid ? `#/s/${sid}${iid ? `/i/${iid}` : ''}` : '';
    if (location.hash !== hash) location.hash = hash; else render();
  }
  window.addEventListener('hashchange', () => {
    const prevImg = state.route.iid;
    parseRoute();
    if (state.route.iid !== prevImg) { state.pinDraft = null; state.replyTo = null; }
    render();
  });

  const currentSection = () => state.project?.sections.find((s) => s.id === state.route.sid) || state.project?.sections[0] || null;
  const openCount = (comments, target) => comments.filter((c) => !c.parentId && !c.resolved && (target === undefined || c.target === target)).length;

  /* ----------------------------------------------------------------- render */
  function render() {
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
      ${topbar()}
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

  function topbar() {
    const admin = isAdmin();
    return `
      <header class="topbar">
        <div class="brand"><div class="brand-mark">${I.logo}</div><span>${esc(state.project.title)}</span></div>
        ${admin ? `<button class="btn ghost sm icon" data-action="rename-project" title="Rename project">${I.edit}</button>` : ''}
        <div class="spacer"></div>
        <button class="btn ghost sm" data-action="refresh" title="Load latest comments">${I.refresh}<span class="hide-sm">Refresh</span></button>
        ${state.name ? `<button class="chip" data-action="change-name" title="Change your name" style="border:0;cursor:pointer">${esc(state.name)}</button>` : ''}
        ${admin ? `<span class="chip admin">Admin</span><button class="btn ghost sm" data-action="admin-out">Sign out</button>` : ''}
      </header>`;
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
        ${!isAdmin() ? `<button class="footer-link" data-action="admin-in">Team sign-in</button>` : ''}
      </nav>`;
  }

  function emptyProject() {
    return isAdmin()
      ? `<div class="empty"><h3>No sections yet</h3><p>Create a section (e.g. “Onboarding”, “Checkout”) and upload screenshots into it.</p><button class="btn primary" data-action="new-section">${I.plus}Create first section</button></div>`
      : `<div class="empty"><h3>Nothing to review yet</h3><p>Screenshots will appear here once the team uploads them.</p></div>`;
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
      ${admin ? `<div class="dropzone" id="dropzone">${I.upload}<span>Drop screenshots here<span class="long">, or paste one with Ctrl/⌘ + V</span></span></div>
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
      ${html || (hidden ? '' : `<div class="no-comments">No comments yet${target === 'section' ? '' : ' — click the screenshot to pin one'}.</div>`)}
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
    const placeholder = parentId ? 'Write a reply…' : isImage ? (state.pinDraft ? 'What about this spot?' : 'Comment on this screenshot, or click it to pin a spot…') : 'Share feedback on this section…';
    return `<form class="composer" data-action="post" data-target="${target}" data-parent="${parentId || ''}" data-key="${key}">
      ${isImage && state.pinDraft ? `<div class="pin-draft">${I.pin.replace('<svg', '<svg width="13" height="13"')}Pinned to a spot<button type="button" data-action="clear-pin" aria-label="Remove pin">×</button></div>` : ''}
      <label class="sr-only" for="ta-${esc(key)}">${placeholder}</label>
      <textarea class="textarea" id="ta-${esc(key)}" data-draft="${esc(key)}" rows="${parentId ? 2 : 3}" maxlength="2000" placeholder="${placeholder}" required>${esc(state.drafts[key] || '')}</textarea>
      <div class="row">
        ${state.name
          ? `<span class="as">Commenting as <b>${esc(state.name)}</b></span>`
          : `<input class="input name-input" name="author" placeholder="Your name" maxlength="60" required autocomplete="name"><span class="as"></span>`}
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
          <button class="btn ghost icon" data-action="close-viewer" title="Close (Esc)">${I.close}</button>
          <div class="title"><b>${esc(img.caption || img.name)}</b><small>${esc(s.title)}</small></div>
          <span class="pos">${idx + 1} / ${s.images.length}</span>
          <button class="btn ghost icon" data-action="toggle-fit" title="${fit ? 'Actual size' : 'Fit to screen'}">${I.fit}</button>
          <button class="btn ghost icon" data-action="copy-link" data-sid="${s.id}" data-iid="${img.id}" title="Copy link to this screenshot">${I.link}</button>
          <button class="btn ghost icon" data-action="nav-image" data-dir="-1" title="Previous (←)" ${idx === 0 ? 'disabled' : ''}>${I.left}</button>
          <button class="btn ghost icon" data-action="nav-image" data-dir="1" title="Next (→)" ${idx === s.images.length - 1 ? 'disabled' : ''}>${I.right}</button>
          ${isAdmin() ? `<button class="btn ghost icon" data-action="edit-caption" title="Edit caption">${I.edit}</button>
            <button class="btn ghost icon danger" data-action="delete-image" title="Delete screenshot">${I.trash}</button>` : ''}
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
              <div class="hint">${I.pin}<span>Click anywhere on the screenshot to pin a comment to that exact spot.</span></div>
              ${threads(s, img.id)}
            </div>
            <div class="panel-foot">${state.replyTo && s.comments.some((c) => c.id === state.replyTo && c.target === img.id) ? '' : composer(s, img.id)}</div>
          </aside>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------------ modal */
  function modal({ title, text = '', fields = [], confirm = 'Save', danger = false, onSubmit }) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <form class="modal" novalidate>
          <h3>${esc(title)}</h3>
          ${text ? `<p>${text}</p>` : ''}
          ${fields.map((f, i) => `<div class="field">
            <label for="mf-${i}">${esc(f.label)}</label>
            ${f.multiline
              ? `<textarea class="textarea" id="mf-${i}" name="${f.name}" maxlength="${f.max || 1000}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
              : `<input class="input" id="mf-${i}" name="${f.name}" type="${f.type || 'text'}" maxlength="${f.max || 200}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} autocomplete="off">`}
          </div>`).join('')}
          <div class="err" hidden></div>
          <div class="row">
            <button type="button" class="btn ghost" data-close>Cancel</button>
            <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(confirm)}</button>
          </div>
        </form>
      </div>`;
    const form = $('form', root);
    const close = () => { root.innerHTML = ''; };
    root.querySelector('[data-close]').onclick = close;
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
        await onSubmit(values);
        close();
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false; btn.disabled = false;
      }
    };
    (form.querySelector('input,textarea') || form.querySelector('[type=submit]')).focus();
  }
  const confirmBox = (title, text, confirm, onSubmit) => modal({ title, text, confirm, danger: true, onSubmit });

  /* ---------------------------------------------------------------- actions */
  const actions = {
    'open-section': (el) => go(el.dataset.sid),
    'open-image': (el) => go(currentSection().id, el.dataset.iid),
    'close-viewer': () => go(state.route.sid),
    'nav-image': (el) => navImage(Number(el.dataset.dir)),
    'refresh': () => load().then(() => toast('Up to date')),
    'toggle-fit': () => { store.set('fit', store.get('fit') === '0' ? '1' : '0'); render(); },
    'toggle-resolved': (el) => { state.showResolved[el.dataset.target] = !state.showResolved[el.dataset.target]; render(); },
    'reply': (el) => { state.replyTo = el.dataset.cid; render(); document.querySelector(`.reply-box textarea`)?.focus(); },
    'cancel-reply': () => { state.replyTo = null; render(); },
    'clear-pin': () => { state.pinDraft = null; render(); },
    'focus-comment': (el) => {
      const t = document.querySelector(`.thread[data-cid="${el.dataset.cid}"]`);
      if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); setHighlight(el.dataset.cid); }
    },
    'copy-link': async (el) => {
      const url = `${location.origin}${location.pathname}#/s/${el.dataset.sid}${el.dataset.iid ? `/i/${el.dataset.iid}` : ''}`;
      try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link:', url); }
    },
    'change-name': () => modal({
      title: 'Your name', text: 'Shown next to the comments you post.',
      fields: [{ name: 'name', label: 'Name', value: state.name, required: true, max: 60 }],
      onSubmit: ({ name }) => { setName(name); render(); },
    }),
    'admin-in': () => modal({
      title: 'Team sign-in', text: 'Enter the admin key to upload screenshots and manage comments.',
      fields: [{ name: 'key', label: 'Admin key', type: 'password', required: true, max: 200 }],
      confirm: 'Sign in',
      onSubmit: async ({ key }) => {
        const prev = state.adminKey;
        state.adminKey = key.trim();
        const me = await api('GET', '/api/me').catch((e) => { state.adminKey = prev; throw e; });
        if (!me.admin) { state.adminKey = prev; throw new Error('That key is not correct.'); }
        state.me = me;
        store.set('adminKey', state.adminKey);
        render();
        toast('Signed in as admin');
      },
    }),
    'admin-out': () => { state.adminKey = ''; store.set('adminKey', null); state.me.admin = false; render(); },
    'rename-project': () => modal({
      title: 'Rename project', fields: [{ name: 'title', label: 'Project title', value: state.project.title, required: true, max: 120 }],
      onSubmit: async ({ title }) => { state.project = await api('PATCH', '/api/project', { title }); document.title = state.project.title; render(); },
    }),
    'new-section': () => modal({
      title: 'New section', text: 'A section groups related screenshots — a feature, a flow or a screen.',
      fields: [
        { name: 'title', label: 'Title', placeholder: 'e.g. Rider sign-up', required: true, max: 120 },
        { name: 'description', label: 'Description (optional)', placeholder: 'What should reviewers focus on?', multiline: true },
      ],
      confirm: 'Create',
      onSubmit: async (v) => { const s = await api('POST', '/api/sections', v); applySection(s); go(s.id); },
    }),
    'edit-section': () => {
      const s = currentSection();
      modal({
        title: 'Edit section',
        fields: [
          { name: 'title', label: 'Title', value: s.title, required: true, max: 120 },
          { name: 'description', label: 'Description', value: s.description, multiline: true },
        ],
        onSubmit: async (v) => { applySection(await api('PATCH', `/api/sections/${s.id}`, v)); render(); },
      });
    },
    'delete-section': () => {
      const s = currentSection();
      confirmBox('Delete section?', `“${esc(s.title)}”, its ${plural(s.images.length, 'screenshot')} and ${plural(s.comments.length, 'comment')} will be removed. The files stay in your repo's git history.`, 'Delete section', async () => {
        await api('DELETE', `/api/sections/${s.id}`);
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
        onSubmit: async (v) => { applySection(await api('PATCH', `/api/sections/${s.id}/images/${img.id}`, v)); render(); },
      });
    },
    'delete-image': () => {
      const s = currentSection();
      const img = s.images.find((i) => i.id === state.route.iid);
      const n = s.comments.filter((c) => c.target === img.id).length;
      confirmBox('Delete screenshot?', `This removes the screenshot${n ? ` and its ${plural(n, 'comment')}` : ''}.`, 'Delete', async () => {
        const idx = s.images.indexOf(img);
        applySection(await api('DELETE', `/api/sections/${s.id}/images/${img.id}`));
        const next = currentSection().images[Math.min(idx, currentSection().images.length - 1)];
        go(s.id, next?.id);
      });
    },
    'resolve': (el) => run(async () => {
      applySection(await api('PATCH', `/api/sections/${currentSection().id}/comments/${el.dataset.cid}`, { resolved: el.dataset.val === '1' }));
      render();
    }),
    'delete-comment': (el) => confirmBox('Delete comment?', 'Replies to it are deleted too.', 'Delete', async () => {
      applySection(await api('DELETE', `/api/sections/${currentSection().id}/comments/${el.dataset.cid}`));
      render();
    }),
    'pick-files': () => $('#file-input')?.click(),
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
      applySection(await api('POST', `/api/sections/${s.id}/comments`, body));
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
      if (file.size > MAX_UPLOAD) { toast(`${file.name} is over 15 MB — skipped`, 'error'); continue; }
      try {
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('Could not read file'));
          r.readAsDataURL(file);
        });
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[file.type];
        const filename = /\.[a-z0-9]+$/i.test(file.name) ? file.name : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
        applySection(await api('POST', `/api/sections/${s.id}/images`, { filename, data }));
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
    const el = e.target.closest('[data-action]');
    if (el && el.tagName !== 'FORM' && actions[el.dataset.action]) {
      e.preventDefault();
      actions[el.dataset.action](el);
      return;
    }
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
      document.querySelector('.panel-foot textarea')?.focus();
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-action="post"]');
    if (form) { e.preventDefault(); postComment(form); }
  });

  document.addEventListener('input', (e) => {
    if (e.target.dataset.draft) state.drafts[e.target.dataset.draft] = e.target.value;
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches?.('textarea[data-draft]') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.target.form.requestSubmit();
      return;
    }
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
    if (!isAdmin() || state.route.iid || e.target.matches?.('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });

  // Pick up other people's comments when someone returns to the tab.
  document.addEventListener('visibilitychange', () => {
    const typing = document.activeElement?.matches?.('textarea, input');
    if (document.visibilityState === 'visible' && state.project && !typing && Date.now() - state.lastLoad > 60_000) load({ quiet: true });
  });

  /* ------------------------------------------------------------------- boot */
  function gate(message) {
    $('#app').innerHTML = `
      <div class="gate">
        <form class="modal" id="gate-form">
          <div class="brand"><div class="brand-mark">${I.logo}</div><span>Design Review</span></div>
          <h3>Enter the review code</h3>
          <p>You should have received it with the link to this page.</p>
          <div class="field"><label for="gate-code">Review code</label><input class="input" id="gate-code" autocomplete="off" required></div>
          ${message ? `<div class="err">${esc(message)}</div>` : ''}
          <div class="row"><button class="btn primary" type="submit">Continue</button></div>
        </form>
      </div>`;
    $('#gate-code').focus();
    $('#gate-form').onsubmit = (e) => {
      e.preventDefault();
      state.code = $('#gate-code').value.trim();
      store.set('code', state.code);
      boot(true);
    };
  }

  function fatal(title, detail) {
    $('#app').innerHTML = `<div class="gate"><div class="modal"><h3>${esc(title)}</h3><p>${detail}</p></div></div>`;
  }

  async function boot(fromGate = false) {
    if (!API || API.includes('YOUR-SUBDOMAIN')) {
      return fatal('Almost there', 'Set <code>apiUrl</code> in <code>config.js</code> to your Cloudflare Worker URL, then reload.');
    }
    // A review code can be shared in the link: …/#/s/abc?code=XYZ or ?code=XYZ
    const urlCode = new URLSearchParams(location.search).get('code');
    if (urlCode) {
      state.code = urlCode; store.set('code', urlCode);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    try {
      state.me = await api('GET', '/api/me');
    } catch (e) {
      return fatal('Can’t reach the review server', esc(e.message));
    }
    if (state.adminKey && !state.me.admin) { state.adminKey = ''; store.set('adminKey', null); }
    if (!state.me.authorized) return gate(fromGate || state.code ? 'That code didn’t work. Please check it and try again.' : '');
    parseRoute();
    await load();
    if (new URLSearchParams(location.search).has('admin') && !isAdmin()) actions['admin-in']();
  }

  boot();
})();
