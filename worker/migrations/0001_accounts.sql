-- Accounts, memberships, invites and the audit log.
-- Apply with: npx wrangler d1 migrations apply review-desk --remote
-- Screenshots and comments stay in the GitHub data repo for now.

-- One row per signed-in person (Clerk user id). Filled in when they first use the API.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,           -- Clerk user id (sub)
  email       TEXT NOT NULL,              -- primary email, lower case, verified by Clerk
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE INDEX users_email ON users (email);

-- Who can edit which space. Reviewers don't need a row: the review link is enough.
CREATE TABLE members (
  space_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users (id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  added_by    TEXT,                       -- user id, or 'claim' / 'request'
  created_at  TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

-- Email invites to become an owner or editor. Only a hash of the token is stored.
CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL,
  email       TEXT NOT NULL,              -- lower case; the invite only works for this address
  role        TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  TEXT NOT NULL,              -- user id
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT,
  revoked_at  TEXT
);
CREATE INDEX invites_space ON invites (space_id);

-- Every email the Worker sends, for daily limits. The address is stored only as a keyed hash.
CREATE TABLE email_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- invite, review-link, request-approved, request-rejected
  space_id    TEXT,
  to_hash     TEXT NOT NULL,
  status      TEXT NOT NULL               -- sent, failed, skipped
);
CREATE INDEX email_log_at ON email_log (at);

-- Append-only record of security-relevant actions.
CREATE TABLE audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  request_id  TEXT,
  actor       TEXT NOT NULL,              -- user id, 'anon' or 'system'
  ip_hash     TEXT,
  action      TEXT NOT NULL,
  space_id    TEXT,
  detail      TEXT                        -- small JSON object, no secrets
);
CREATE INDEX audit_space ON audit (space_id, at);
