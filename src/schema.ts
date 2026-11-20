// The database tables, created on first use so a fresh D1 database works straight after a Git deploy,
// without running `wrangler d1 migrations apply`. Same tables as migrations/0001_init.sql; every statement is safe to repeat.
import type { Env } from "./mail";
import catalogue from "../tools/catalogue.json";
import lessons from "../tools/lessons.json";
import { getDoc, putDoc } from "./store";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, upd INTEGER NOT NULL, PRIMARY KEY (coll, id))",
  "CREATE TABLE IF NOT EXISTS admins (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, skey TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS login_attempts (k TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_attempts ON login_attempts(k, at)",
  "CREATE TABLE IF NOT EXISTS email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)",
];

let ready: Promise<unknown> | null = null;
/** Runs once per Worker instance; a failure is retried on the next request. */
export function ensureSchema(env: Env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}

/** Loads the 20 certifications from tools/catalogue.json with their module links. A course that already exists is left alone. */
export async function seedCatalogue(env: Env) {
  const links = lessons as Record<string, { title: string; url: string }[]>;
  let added = 0;
  for (const { id, ...c } of (catalogue as { courses: Record<string, any>[] }).courses) {
    if (await getDoc(env, "courses", id)) continue;
    const modules = (c.modules as { title: string }[]).map((m, i) => ({ title: m.title, lessons: links[id]?.[i] ? [{ title: m.title, url: links[id][i].url }] : [] }));
    await putDoc(env, "courses", id, { ...c, modules });
    added++;
  }
  return added;
}
