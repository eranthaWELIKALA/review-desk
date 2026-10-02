// Local stand-in for Clerk, served by dev/server.mjs as /dev-clerk.js. "Sign in" with
// any email; tokens are real RS256 JWTs signed by the dev server, so the Worker
// verifies them exactly as it would Clerk's. Never used in production.
(() => {
  const KEY = 'dev-clerk-user';
  const listeners = [];
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };

  const Clerk = {
    user: null,
    session: null,
    async load() { set(read(), false); },
    addListener(cb) { listeners.push(cb); },
    openSignIn() {
      const email = prompt('Dev sign-in: email address\n(admin@dev.local is the site admin)', read()?.email || 'admin@dev.local');
      if (!email) return;
      const name = prompt('Name', email.split('@')[0]) || '';
      const mfa = confirm('Has this account done two-step verification?\n(The admin console needs it.)');
      const id = 'user_' + Array.from(email.toLowerCase()).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
      const u = { id, email: email.trim().toLowerCase(), name: name.trim(), mfa };
      localStorage.setItem(KEY, JSON.stringify(u));
      set(u);
    },
    openUserProfile() { alert('Dev sign-in has no account settings. Sign out and sign in again to change the user or two-step verification.'); },
    async signOut() { localStorage.removeItem(KEY); set(null); },
  };

  function set(u, notify = true) {
    Clerk.user = u ? { id: u.id, fullName: u.name, primaryEmailAddress: { emailAddress: u.email } } : null;
    Clerk.session = u ? {
      async getToken() {
        const res = await fetch('/dev-clerk/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) });
        return (await res.json()).token;
      },
    } : null;
    if (notify) for (const cb of listeners) cb({ user: Clerk.user });
  }

  window.Clerk = Clerk;
})();
