// In-memory stand-in for the parts of the GitHub REST API the Worker uses:
// the Contents API (per branch) and the Git Data API (refs, commits, trees, blobs).
// Shared by the Worker tests and the local dev server.
import crypto from 'node:crypto';

export function createFakeGitHub({ branches = ['review-data'], state, onChange } = {}) {
  const blobs = new Map(state?.blobs || []);       // sha -> base64
  const trees = new Map((state?.trees || []).map(([k, v]) => [k, new Map(v)])); // sha -> Map(path -> blob sha)
  const commits = new Map(state?.commits || []);   // sha -> { tree, parents, message }
  const refs = new Map(state?.refs || []);         // branch -> commit sha
  const calls = [];
  let n = 0;

  const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
  const putBlob = (b64) => { const sha = hash(`blob:${b64}`); blobs.set(sha, b64); return sha; };
  const putTree = (map) => { const sha = hash(`tree:${JSON.stringify([...map].sort())}`); trees.set(sha, new Map(map)); return sha; };
  const putCommit = (tree, parents, message) => {
    const sha = hash(`commit:${tree}:${parents}:${message}:${++n}:${Math.random()}`);
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  const filesOf = (br) => (refs.has(br) ? trees.get(commits.get(refs.get(br)).tree) : null);
  const commitTo = (br, map, message) => {
    refs.set(br, putCommit(putTree(map), refs.has(br) ? [refs.get(br)] : [], message));
    onChange?.();
  };
  if (!state) for (const b of branches) commitTo(b, new Map(), 'init');

  const ok = (body, status = 200) => Response.json(body, { status });
  const fail = (status) => new Response('{}', { status });

  async function handle(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    const m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+(\/.*)$/);
    if (!m) return fail(404);
    const p = m[1];
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push(`${method} ${decodeURIComponent(p)}`);

    // ---- Contents API
    const c = p.match(/^\/contents\/(.+)$/);
    if (c) {
      const path = c[1].split('/').map(decodeURIComponent).join('/');
      const br = method === 'GET' ? u.searchParams.get('ref') : body.branch;
      const files = filesOf(br);
      if (!files) return fail(404);
      const cur = files.get(path);
      if (method === 'GET') {
        if (!cur) return fail(404);
        if (String(init.headers?.Accept || '').includes('raw')) return new Response(Buffer.from(blobs.get(cur), 'base64'));
        return ok({ sha: cur, encoding: 'base64', content: blobs.get(cur).replace(/(.{60})/g, '$1\n') });
      }
      if (method === 'PUT') {
        if (cur && body.sha !== cur) return fail(409);
        if (!cur && body.sha) return fail(422);
        const next = new Map(files).set(path, putBlob(body.content));
        commitTo(br, next, body.message);
        return ok({ content: { sha: next.get(path) } });
      }
      if (method === 'DELETE') {
        if (!cur || body.sha !== cur) return fail(409);
        const next = new Map(files);
        next.delete(path);
        commitTo(br, next, body.message);
        return ok({});
      }
    }

    // ---- Git Data API
    let g;
    if ((g = p.match(/^\/git\/ref\/heads\/(.+)$/)) && method === 'GET') {
      const sha = refs.get(decodeURIComponent(g[1]));
      return sha ? ok({ object: { sha } }) : fail(404);
    }
    if (p === '/git/refs' && method === 'POST') {
      const br = body.ref.replace(/^refs\/heads\//, '');
      if (refs.has(br)) return fail(422);
      if (!commits.has(body.sha)) return fail(422);
      refs.set(br, body.sha);
      onChange?.();
      return ok({ ref: body.ref }, 201);
    }
    if ((g = p.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      const br = decodeURIComponent(g[1]);
      const next = commits.get(body.sha);
      if (!refs.has(br) || !next) return fail(422);
      if (!body.force && !next.parents.includes(refs.get(br))) return fail(422); // not a fast-forward
      refs.set(br, body.sha);
      onChange?.();
      return ok({ object: { sha: body.sha } });
    }
    if ((g = p.match(/^\/git\/commits\/([0-9a-f]+)$/)) && method === 'GET') {
      const cm = commits.get(g[1]);
      return cm ? ok({ sha: g[1], tree: { sha: cm.tree }, parents: cm.parents.map((sha) => ({ sha })) }) : fail(404);
    }
    if (p === '/git/commits' && method === 'POST') {
      if (!trees.has(body.tree)) return fail(422);
      return ok({ sha: putCommit(body.tree, body.parents || [], body.message) }, 201);
    }
    if ((g = p.match(/^\/git\/trees\/([0-9a-f]+)$/)) && method === 'GET') {
      const t = trees.get(g[1]);
      if (!t) return fail(404);
      // Like GitHub's recursive listing: directories appear as "tree" entries.
      const dirs = new Set();
      for (const path of t.keys()) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      return ok({
        sha: g[1], truncated: false,
        tree: [
          ...[...dirs].map((path) => ({ path, mode: '040000', type: 'tree', sha: hash(path) })),
          ...[...t].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })),
        ],
      });
    }
    if (p === '/git/trees' && method === 'POST') {
      const map = body.base_tree ? new Map(trees.get(body.base_tree)) : new Map();
      for (const e of body.tree) {
        if (e.content !== undefined) map.set(e.path, putBlob(Buffer.from(e.content, 'utf8').toString('base64')));
        else if (blobs.has(e.sha)) map.set(e.path, e.sha);
        else return fail(422);
      }
      return ok({ sha: putTree(map) }, 201);
    }
    if ((g = p.match(/^\/git\/blobs\/([0-9a-f]+)$/)) && method === 'GET') {
      const b = blobs.get(g[1]);
      return b ? ok({ sha: g[1], encoding: 'base64', content: b }) : fail(404);
    }
    return fail(404);
  }

  return {
    handle,
    calls,
    /** Current files on a branch as { path: Buffer }, or null if the branch doesn't exist. */
    files(br = 'review-data') {
      const map = filesOf(br);
      return map ? Object.fromEntries([...map].map(([path, sha]) => [path, Buffer.from(blobs.get(sha), 'base64')])) : null;
    },
    /** Number of commits reachable from a branch head. */
    history(br) {
      let sha = refs.get(br);
      let count = 0;
      while (sha) { count++; sha = commits.get(sha).parents[0]; }
      return count;
    },
    serialize() {
      // Only keep objects reachable from a branch, so dev data doesn't grow forever.
      const live = { blobs: new Set(), trees: new Set(), commits: new Set() };
      for (const head of refs.values()) {
        for (let sha = head; sha && !live.commits.has(sha); sha = commits.get(sha).parents[0]) {
          live.commits.add(sha);
          const t = commits.get(sha).tree;
          live.trees.add(t);
          for (const b of trees.get(t).values()) live.blobs.add(b);
        }
      }
      return {
        blobs: [...blobs].filter(([k]) => live.blobs.has(k)),
        trees: [...trees].filter(([k]) => live.trees.has(k)).map(([k, v]) => [k, [...v]]),
        commits: [...commits].filter(([k]) => live.commits.has(k)),
        refs: [...refs],
      };
    },
  };
}

/** Routes api.github.com calls to the fake; everything else goes to the real fetch. */
export function installFakeGitHub(fake) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const href = typeof url === 'string' ? url : url.url;
    return new URL(href).hostname === 'api.github.com' ? fake.handle(href, init) : realFetch(url, init);
  };
  return () => { globalThis.fetch = realFetch; };
}
