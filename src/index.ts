import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { hashPassword, verifyPassword, sha256, newToken } from "./crypto";
import { brand, sendMail, smtpSend, type Env } from "./mail";
import { addDoc, knownColl, readDoc, readList, writeDoc, type Ctx } from "./rules";
import { delDoc, getDoc, listDocs, putDoc } from "./store";
import { HttpErr, S, isHex64, lmKey } from "./util";
import { registerShop, coursePage } from "./shop";
import { runScheduled } from "./jobs";
import { ensureSchema, seedCatalogue } from "./schema";

type Vars = { ctx: Ctx; session?: { token: string } };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
const SESSION_MS = 14 * 864e5;

app.onError((e, c) => {
  if (e instanceof HttpErr) return c.json({ error: e.message }, e.status as 400);
  console.error(e);
  return c.json({ error: "Server error" }, 500);
});

// a fresh database gets its tables on first use
app.use("*", async (c, next) => { await ensureSchema(c.env); await next(); });

// same-origin only for anything that changes data
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "Bad origin" }, 403);
    if (!(c.req.header("Content-Type") || "").includes("application/json")) return c.json({ error: "JSON only" }, 415);
  }
  // who is calling
  let uid = getCookie(c, "tcc_anon");
  if (!uid || !/^[0-9a-f]{32}$/.test(uid)) {
    uid = newToken().slice(0, 32);
    setCookie(c, "tcc_anon", uid, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 365 * 864e2 });
  }
  const ctx: Ctx = { role: "anon", key: "", uid, ip: c.req.header("CF-Connecting-IP") || "local" };
  const tok = getCookie(c, "tcc_session");
  if (tok) {
    const s = await c.env.DB.prepare("SELECT role,email,name,skey,expires_at FROM sessions WHERE token_hash=?").bind(await sha256(tok)).first<any>();
    if (s && s.expires_at > Date.now()) { ctx.role = s.role === "admin" ? "admin" : "learner"; ctx.key = s.skey; c.set("session", { token: tok }); (ctx as any).name = s.name; (ctx as any).email = s.email; }
  }
  c.set("ctx", ctx);
  await next();
});

async function body(c: Context): Promise<Record<string, any>> {
  try { const j = await c.req.json(); if (j && typeof j === "object") return j; } catch {}
  throw new HttpErr(400, "Invalid JSON");
}
async function attempts(env: Env, k: string, max: number) {
  const since = Date.now() - 15 * 60_000;
  const r = await env.DB.prepare("SELECT COUNT(*) n FROM login_attempts WHERE k=? AND at>?").bind(k, since).first<{ n: number }>();
  return (r?.n ?? 0) >= max;
}
const failed = (env: Env, k: string) => env.DB.prepare("INSERT INTO login_attempts (k,at) VALUES (?,?)").bind(k, Date.now()).run();

// ---------- first admin (works once, needs the secret setup token) ----------
app.post("/api/setup", async (c) => {
  if (!c.env.SETUP_TOKEN || c.req.header("X-Setup-Token") !== c.env.SETUP_TOKEN) throw new HttpErr(403, "Not allowed");
  if (await c.env.DB.prepare("SELECT 1 FROM admins LIMIT 1").first()) throw new HttpErr(409, "Admin already exists");
  const b = await body(c);
  if (!/^\S+@\S+\.\S+$/.test(String(b.email)) || !isHex64(b.h)) throw new HttpErr(400, "Need email and password hash");
  const p = await hashPassword(b.h);
  await c.env.DB.prepare("INSERT INTO admins (email,name,pw_hash,pw_salt) VALUES (?,?,?,?)").bind(String(b.email).toLowerCase(), S(b.name, 80) || "Admin", p.hash, p.salt).run();
  // the setup page also loads the 20 certifications (courses that already exist are kept)
  const courses = b.seed === true ? await seedCatalogue(c.env) : 0;
  return c.json({ ok: true, courses });
});

// ---------- login ----------
app.post("/api/login", async (c) => {
  const ctx = c.get("ctx");
  const b = await body(c);
  const email = String(b.e || "").trim().toLowerCase().slice(0, 120), h = String(b.h || "");
  const key = lmKey(email);
  const out: Record<string, any> = { ok: false, block: false };
  if (!key || !isHex64(h)) return c.json(out);
  if ((await attempts(c.env, "login:" + key, 8)) || (await attempts(c.env, "loginip:" + ctx.ip, 40))) return c.json({ ok: false, block: true, msg: "rate" }, 429);

  let sess: { role: string; name: string } | null = null;
  const adm = await c.env.DB.prepare("SELECT name,pw_hash,pw_salt FROM admins WHERE email=?").bind(email).first<any>();
  if (adm) {
    if (await verifyPassword(h, adm.pw_hash, adm.pw_salt)) { sess = { role: "admin", name: adm.name }; out.role = "admin"; out.n = adm.name; }
  } else {
    const a = await getDoc(c.env, "lacct", key);
    if (a) {
      if (a.gone) out.block = true;
      else {
        if (Array.isArray(a.c)) out.c = a.c.slice(0, 60);
        if (a.lock) { out.block = true; out.msg = "locked"; }
        else if (a._pw && (await verifyPassword(h, a._pw.hash, a._pw.salt))) { sess = { role: "learner", name: S(a.n, 80) }; out.n = S(a.n, 80); }
        else out.block = true;
      }
    } else await hashPassword(h); // keep timing similar when the email is unknown
  }
  if (!sess) { await failed(c.env, "login:" + key); await failed(c.env, "loginip:" + ctx.ip); return c.json(out, out.block ? 200 : 200); }
  const tok = newToken();
  await c.env.DB.prepare("INSERT INTO sessions (token_hash,role,email,name,skey,expires_at) VALUES (?,?,?,?,?,?)")
    .bind(await sha256(tok), sess.role, email, sess.name, key, Date.now() + SESSION_MS).run();
  setCookie(c, "tcc_session", tok, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_MS / 1000 });
  out.ok = true; out.role = sess.role;
  return c.json(out);
});

app.post("/api/logout", async (c) => {
  const tok = getCookie(c, "tcc_session");
  if (tok) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(tok)).run();
  deleteCookie(c, "tcc_session", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/whoami", (c) => {
  const x = c.get("ctx") as any;
  return c.json({ role: x.role, uid: x.uid, key: x.key, n: x.name || "", e: x.email || "" });
});

// ---------- forgot / reset password ----------
const RESET_MS = 30 * 60_000;
// Links in emails point at SITE_ORIGIN when it is set, otherwise at the address the request came in on.
const siteOrigin = (c: Context) => String(c.env.SITE_ORIGIN || "").replace(/\/+$/, "") || new URL(c.req.url).origin;
async function resetTarget(env: Env, t: string) {
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const id = await sha256(t);
  const r = await getDoc(env, "rtok", id);
  if (!r || r.exp < Date.now()) { if (r) await delDoc(env, "rtok", id); return null; }
  if (r.kind === "a") {
    const adm = await env.DB.prepare("SELECT email,name FROM admins WHERE email=?").bind(String(r.e || "")).first<any>();
    return adm ? { id, r, a: { e: adm.email, n: adm.name } } : null;
  }
  const a = await getDoc(env, "lacct", r.k);
  if (!a || a.gone || a.lock) return null;
  return { id, r, a };
}
app.post("/api/forgot", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const b = await body(c);
  const email = String(b.e || "").trim().toLowerCase().slice(0, 120);
  const key = lmKey(email);
  const reply = { ok: true };
  if (!key || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json(reply);
  if ((await attempts(c.env, "fgt:" + key, 3)) || (await attempts(c.env, "fgtip:" + ctx.ip, 10))) return c.json(reply);
  await failed(c.env, "fgt:" + key); await failed(c.env, "fgtip:" + ctx.ip);
  let kind = "l";
  let a = await getDoc(c.env, "lacct", key);
  if (!a) {
    const adm = await c.env.DB.prepare("SELECT email,name FROM admins WHERE email=?").bind(email).first<any>();
    if (adm) { a = { e: adm.email, n: adm.name, _pw: {} }; kind = "a"; }
  }
  // a learner who enrolled online may not have chosen a password yet: the link lets them set one
  if (!a || a.gone || a.lock || !a.e || (kind !== "l" && !a._pw)) return c.json(reply);
  const token = newToken();
  await putDoc(c.env, "rtok", await sha256(token), { k: key, kind, e: kind === "a" ? email : undefined, exp: Date.now() + RESET_MS });
  const link = `${siteOrigin(c)}/set-password?t=${token}`;
  const job = sendMail(c.env, S(a.e, 120), `Reset your ${brand(c.env)} password`,
    `Hi ${S(a.n, 80)},\n\nSomeone asked to reset the password for your ${brand(c.env)} account. Use this link to choose a new one. It works once and expires in 30 minutes:\n\n${link}\n\nIf this was not you, you can ignore this email and your password will stay the same.\n\n${brand(c.env)}`);
  try { c.executionCtx.waitUntil(job); } catch { await job; }
  return c.json(reply);
});
app.get("/api/reset/check", async (c) => {
  const t = await resetTarget(c.env, String(c.req.query("t") || ""));
  return c.json(t ? { ok: true, e: S(t.a.e, 120) } : { ok: false });
});
app.post("/api/reset", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const b = await body(c);
  if (await attempts(c.env, "rst:" + ctx.ip, 20)) throw new HttpErr(429, "Too many tries. Please wait 15 minutes.");
  await failed(c.env, "rst:" + ctx.ip);
  if (!isHex64(b.h)) throw new HttpErr(400, "Invalid request");
  const t = await resetTarget(c.env, String(b.t || ""));
  if (!t) throw new HttpErr(410, "This link has expired.");
  const pw = await hashPassword(b.h);
  if (t.r.kind === "a") {
    await c.env.DB.prepare("UPDATE admins SET pw_hash=?,pw_salt=? WHERE email=?").bind(pw.hash, pw.salt, S(t.a.e, 120)).run();
    await delDoc(c.env, "rtok", t.id);
    await c.env.DB.prepare("DELETE FROM sessions WHERE skey=?").bind(t.r.k).run();
    return c.json({ ok: true });
  }
  await putDoc(c.env, "lacct", t.r.k, { ...t.a, _pw: { hash: pw.hash, salt: pw.salt } });
  await delDoc(c.env, "rtok", t.id);
  await c.env.DB.prepare("DELETE FROM sessions WHERE skey=?").bind(t.r.k).run();
  return c.json({ ok: true });
});

// ---------- a learner's own account ----------
const learnerOnly = (c: Context) => {
  const x = c.get("ctx") as Ctx;
  if (x.role !== "learner" || !x.key) throw new HttpErr(401, "Please sign in again");
  return x;
};
app.get("/api/me", async (c) => {
  const x = learnerOnly(c);
  const a = await getDoc(c.env, "lacct", x.key);
  if (!a || a.gone) throw new HttpErr(404, "Account not found");
  return c.json({ n: S(a.n, 80), e: S(a.e, 120), rem: a.rem !== false });
});
app.post("/api/me/profile", async (c) => {
  const x = learnerOnly(c);
  const b = await body(c);
  const n = S(b.n, 80).trim();
  if (!n) throw new HttpErr(400, "Please add your name.");
  const a = await getDoc(c.env, "lacct", x.key);
  if (!a || a.gone) throw new HttpErr(404, "Account not found");
  const rem = typeof b.rem === "boolean" ? b.rem : a.rem !== false; // study reminder emails, on unless turned off
  await putDoc(c.env, "lacct", x.key, { ...a, n, rem });
  await c.env.DB.prepare("UPDATE sessions SET name=? WHERE skey=? AND role='learner'").bind(n, x.key).run();
  return c.json({ ok: true, n, rem });
});
app.post("/api/me/password", async (c) => {
  const x = learnerOnly(c);
  const b = await body(c);
  if (!isHex64(b.cur) || !isHex64(b.h)) throw new HttpErr(400, "Invalid request");
  if (await attempts(c.env, "pw:" + x.key, 6)) throw new HttpErr(429, "Too many tries. Please wait 15 minutes.");
  const a = await getDoc(c.env, "lacct", x.key);
  if (!a || a.gone || !a._pw) throw new HttpErr(404, "Account not found");
  if (!(await verifyPassword(b.cur, a._pw.hash, a._pw.salt))) { await failed(c.env, "pw:" + x.key); throw new HttpErr(403, "Your current password is not right."); }
  if (b.cur === b.h) throw new HttpErr(400, "Choose a password you have not used here before.");
  const pw = await hashPassword(b.h);
  await putDoc(c.env, "lacct", x.key, { ...a, _pw: { hash: pw.hash, salt: pw.salt } });
  return c.json({ ok: true });
});

app.post("/api/me/email", async (c) => {
  const x = learnerOnly(c);
  const b = await body(c);
  const e = S(b.e, 120).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpErr(400, "Please enter a valid email address.");
  if (!isHex64(b.cur) || !isHex64(b.h)) throw new HttpErr(400, "Invalid request");
  if (await attempts(c.env, "pw:" + x.key, 6)) throw new HttpErr(429, "Too many tries. Please wait 15 minutes.");
  const a = await getDoc(c.env, "lacct", x.key);
  if (!a || a.gone || !a._pw) throw new HttpErr(404, "Account not found");
  if (!(await verifyPassword(b.cur, a._pw.hash, a._pw.salt))) { await failed(c.env, "pw:" + x.key); throw new HttpErr(403, "Your current password is not right."); }
  const nk = lmKey(e);
  if (!nk) throw new HttpErr(400, "Please enter a valid email address.");
  if (nk !== x.key) {
    const clash = (await getDoc(c.env, "lacct", nk)) ||
      (await c.env.DB.prepare("SELECT 1 AS x FROM admins WHERE email=?").bind(e).first());
    if (clash) throw new HttpErr(409, "That email address is already in use.");
  }
  const pw = await hashPassword(b.h);
  await putDoc(c.env, "lacct", nk, { ...a, e, _pw: { hash: pw.hash, salt: pw.salt } });
  if (nk !== x.key) {
    const d = await getDoc(c.env, "lsub", x.key);
    if (d) { await putDoc(c.env, "lsub", nk, d); await delDoc(c.env, "lsub", x.key); }
    // exam records and certificates follow the learner to the new email
    for (const r of await listDocs(c.env, "lexam", { field: "k", value: x.key })) {
      await putDoc(c.env, "lexam", `${nk}--${S(r.data.course, 24)}`, { ...r.data, k: nk });
      await delDoc(c.env, "lexam", r.id);
    }
    for (const r of await listDocs(c.env, "certs", { field: "k", value: x.key })) await putDoc(c.env, "certs", r.id, { ...r.data, k: nk });
    await delDoc(c.env, "lacct", x.key);
  }
  await c.env.DB.prepare("UPDATE sessions SET skey=?,email=? WHERE skey=? AND role='learner'").bind(nk, e, x.key).run();
  return c.json({ ok: true, e });
});

// ---------- data (document store with server-side rules) ----------
const parsePath = (p: string) => {
  const parts = String(p || "").split("/");
  if (parts.length < 2) throw new HttpErr(400, "Bad path");
  const id = parts.pop()!;
  const coll = parts.join("/");
  if (!knownColl(coll)) throw new HttpErr(403, "Not allowed");
  return { coll, id };
};

const enrolled = async (env: Env, ctx: Ctx) => {
  const a = await getDoc(env, "lacct", ctx.key);
  return new Set<string>(a && !a.gone && !a.lock && Array.isArray(a.c) ? a.c.map(String) : []);
};

app.get("/api/db/doc", async (c) => {
  const { coll, id } = parsePath(c.req.query("path") || "");
  const d = await getDoc(c.env, coll, id);
  if (coll === "courses" && c.get("ctx").role === "learner" && !(await enrolled(c.env, c.get("ctx"))).has(id)) throw new HttpErr(403, "Not allowed");
  return c.json(await readDoc(c.get("ctx"), coll, id, d));
});
app.get("/api/db/list", async (c) => {
  const coll = c.req.query("coll") || "";
  if (!knownColl(coll)) throw new HttpErr(403, "Not allowed");
  const f = c.req.query("field"), v = c.req.query("value");
  const where = f ? { field: f, value: /^-?\d+(\.\d+)?$/.test(v || "") ? Number(v) : String(v) } : undefined;
  let docs = await readList(c.env, c.get("ctx"), coll, where);
  if (coll === "courses" && c.get("ctx").role === "learner") { const mine = await enrolled(c.env, c.get("ctx")); docs = docs.filter((d) => mine.has(d.id)); }
  return c.json({ docs });
});
app.post("/api/db/doc", async (c) => {
  const b = await body(c);
  const { coll, id } = parsePath(String(b.path || ""));
  const op = b.op === "update" ? "update" : b.op === "delete" ? "delete" : "set";
  await writeDoc(c.env, c.get("ctx"), op, coll, id, b.data && typeof b.data === "object" ? b.data : {});
  return c.json({ ok: true });
});
app.post("/api/db/add", async (c) => {
  const b = await body(c);
  const id = await addDoc(c.env, c.get("ctx"), String(b.coll || ""), b.data && typeof b.data === "object" ? b.data : {});
  return c.json({ ok: true, id });
});

app.get("/api/admin/emails", async (c) => {
  if (c.get("ctx").role !== "admin") throw new HttpErr(403, "Not allowed");
  return c.json({ emails: (await c.env.DB.prepare("SELECT * FROM email_log ORDER BY id DESC LIMIT 100").all()).results });
});

// Admin-only: shows whether the Stripe keys reach the site, and which mode they are in. Never shows the keys.
app.get("/api/admin/pay-check", (c) => {
  if (c.get("ctx").role !== "admin") throw new HttpErr(403, "Not allowed");
  const k = String(c.env.STRIPE_SECRET_KEY || ""), w = String(c.env.STRIPE_WEBHOOK_SECRET || "");
  const kind = (v: string) => (!v ? "missing" : /^(sk|rk)_test_/.test(v) ? "test key" : /^(sk|rk)_live_/.test(v) ? "live key" : v.trim() !== v ? "has a space before or after it" : "not a secret key (should start with sk_test_ or sk_live_)");
  return c.json({
    STRIPE_SECRET_KEY: kind(k),
    STRIPE_WEBHOOK_SECRET: !w ? "missing" : /^whsec_/.test(w.trim()) ? (w.trim() === w ? "set" : "has a space before or after it") : "not a webhook secret (should start with whsec_)",
    webhook_url: new URL("/api/stripe/webhook", c.req.url).toString(),
    payments_on: !!k,
  });
});

// Admin-only: shows whether the mailbox settings are set and whether the mail server accepts them. Never shows secrets.
app.get("/api/admin/mail-check", async (c) => {
  if (c.get("ctx").role !== "admin") throw new HttpErr(403, "Not allowed");
  const e = c.env;
  const cfg = { SMTP_USER: !!e.SMTP_USER, SMTP_PASS: !!e.SMTP_PASS, SMTP_HOST: e.SMTP_HOST || "(default) mail.privateemail.com", user: e.SMTP_USER || "" };
  const probe = await smtpSend(e, "", "", "", true);
  const to = String(c.req.query("to") || "").trim().toLowerCase();
  let test: any = null;
  if (to && probe.ok) test = await smtpSend(e, to, `${brand(e)} email test`, `This is a test email from the ${brand(e)} website. If you can read this, system email is working.`);
  return c.json({ config: cfg, login: probe, test });
});

// Admin-only: re-sends team notices (sent to the team inbox) that failed before the mailbox settings were working.
app.get("/api/admin/mail-resend", async (c) => {
  if (c.get("ctx").role !== "admin") throw new HttpErr(403, "Not allowed");
  const team = (c.env.NOTIFY_TO || c.env.SMTP_USER || "").toLowerCase();
  const rows = (await c.env.DB.prepare("SELECT id,to_email,subject,body,created_at FROM email_log WHERE sent=0 AND lower(to_email)=? ORDER BY id LIMIT 25").bind(team).all()).results as any[];
  const done: number[] = [], failed: { id: number; err?: string }[] = [];
  for (const r of rows) {
    const body = `(Resent: first tried ${r.created_at})\n\n${r.body}`;
    const res = await smtpSend(c.env, r.to_email, r.subject, body);
    if (res.ok) { await c.env.DB.prepare("UPDATE email_log SET sent=1 WHERE id=?").bind(r.id).run(); done.push(r.id); }
    else failed.push({ id: r.id, err: res.err });
  }
  return c.json({ resent: done, failed });
});

registerShop(app);

// Each certification has its own address, e.g. /certified-life-coach. The page is sent with that course's title,
// description and link-preview details already in it; an address that matches no course is a real 404.
app.get("/:slug{certified-[a-z0-9-]+}", (c) => coursePage(c, c.req.param("slug")));

export default {
  fetch: app.fetch,
  // hourly: see wrangler.toml [triggers]
  scheduled(ev: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(runScheduled(env, ev.scheduledTime)); },
};
