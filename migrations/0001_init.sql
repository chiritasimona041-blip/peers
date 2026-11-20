-- Document store with server-side access rules, plus auth tables.
CREATE TABLE IF NOT EXISTS docs (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  upd INTEGER NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  skey TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  k TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON login_attempts(k, at);
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
