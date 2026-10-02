// A small stand-in for a Cloudflare D1 binding, backed by node:sqlite in memory or
// a file. Enough of the API for the Worker: prepare().bind().first()/all()/run(), batch().
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'migrations');

export function createFakeD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  for (const name of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    db.exec(readFileSync(path.join(migrations, name), 'utf8'));
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  }

  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    async first(col) {
      const row = db.prepare(sql).get(...args);
      return row ? (col ? row[col] : { ...row }) : null;
    },
    async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })), success: true }; },
    async run() {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec() { return db.prepare(sql).run(...args); },
  });

  return {
    prepare: (sql) => statement(sql),
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => { const r = s._exec(); return { success: true, meta: { changes: Number(r.changes) } }; });
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    raw: db,
  };
}
