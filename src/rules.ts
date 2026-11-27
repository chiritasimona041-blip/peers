import { hashPassword } from "./crypto";
import { brand, sendMail, sendLetter, firstName, siteUrl, type Env } from "./mail";
import { delDoc, getDoc, putDoc, listDocs, type Doc } from "./store";
import { HttpErr, S, isHex64 } from "./util";

export type Ctx = { role: "admin" | "learner" | "anon"; key: string; uid: string; ip: string };

const MAX_DOC = 700_000;
const strip = (d: Doc) => {
  const o: Doc = {};
  for (const k of Object.keys(d)) if (k[0] !== "_" && k !== "h") o[k] = d[k];
  return o;
};
const isAdmin = (c: Ctx) => c.role === "admin";
const mine = (c: Ctx, id: string) => c.role === "learner" && id === c.key;
// courses: what is sold and taught. exams: questions and answers. certs: issued certificates. orders: payments.
// lacct: learner accounts. lsub: a learner's lesson progress. leads: contact form enquiries.
const COLL_OK = /^(courses|exams|certs|orders|lacct|lsub|leads\/[A-Za-z0-9_-]{1,64}\/items)$/;
export const knownColl = (c: string) => COLL_OK.test(c);
const sizeOk = (d: unknown) => JSON.stringify(d).length <= MAX_DOC;
const obj = (v: unknown): Doc => (v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {});

// ---- reads ----
export async function readDoc(ctx: Ctx, coll: string, id: string, d: Doc | null): Promise<{ exists: boolean; data: Doc }> {
  // permission is decided before existence, so a refused read looks the same whether or not the document exists
  const allowed =
    isAdmin(ctx) ||
    ((coll === "lacct" || coll === "lsub") && mine(ctx, id)) ||
    (coll === "courses" && ctx.role === "learner"); // index.ts also checks the learner is enrolled on it
  if (!allowed) throw new HttpErr(403, "Not allowed");
  if (!d) return { exists: false, data: {} };
  return { exists: true, data: coll === "lacct" ? strip(d) : d };
}
export async function readList(env: Env, ctx: Ctx, coll: string, where?: { field: string; value: string | number }) {
  if (!(isAdmin(ctx) || (coll === "courses" && ctx.role === "learner"))) throw new HttpErr(403, "Not allowed");
  const rows = await listDocs(env, coll, where);
  return rows.map((r) => ({ id: r.id, data: coll === "lacct" ? strip(r.data) : r.data }));
}

// ---- writes ----
async function withPw(next: Doc, prev: Doc | null) {
  if (isHex64(next.h)) { const p = await hashPassword(next.h); next._pw = { hash: p.hash, salt: p.salt }; }
  else if (prev && prev._pw) next._pw = prev._pw;
  delete next.h;
  return next;
}
async function limit(env: Env, k: string, max: number, windowMs: number) {
  const since = Date.now() - windowMs;
  const r = await env.DB.prepare("SELECT COUNT(*) n FROM login_attempts WHERE k=? AND at>?").bind(k, since).first<{ n: number }>();
  if ((r?.n ?? 0) >= max) throw new HttpErr(429, "Too many requests, try again later");
  await env.DB.prepare("INSERT INTO login_attempts (k,at) VALUES (?,?)").bind(k, Date.now()).run();
}

export async function writeDoc(env: Env, ctx: Ctx, op: "set" | "update" | "delete", coll: string, id: string, incoming: Doc) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new HttpErr(400, "Bad id");
  const prev = await getDoc(env, coll, id);
  if (op !== "delete" && !sizeOk(incoming)) throw new HttpErr(413, "Too large");
  const merged = (): Doc => (op === "update" ? { ...(prev || {}), ...incoming } : { ...incoming });

  switch (coll) {
    case "courses":
    case "exams": { // admin only; exam answers never leave through the learner routes
      if (!isAdmin(ctx)) throw new HttpErr(403, "Not allowed");
      if (op === "delete") return delDoc(env, coll, id);
      return putDoc(env, coll, id, merged());
    }
    case "certs": { // issued by passing the exam; an admin may only revoke or restore one
      if (!isAdmin(ctx) || !prev || op === "delete") throw new HttpErr(403, "Not allowed");
      return putDoc(env, coll, id, { ...prev, revoked: !!incoming.revoked });
    }
    case "lacct": { // admin creates, edits, locks or removes a learner (online buyers are created by the payment webhook)
      if (!isAdmin(ctx)) throw new HttpErr(403, "Not allowed");
      if (op === "delete") return delDoc(env, coll, id);
      const m = await withPw(merged(), prev);
      const clean: Doc = { n: S(m.n, 80), e: S(m.e, 120), c: Array.isArray(m.c) ? m.c.map(String).filter((x: string) => /^[A-Za-z0-9-]{1,24}$/.test(x)).slice(0, 60) : [],
        lock: !!m.lock, gone: !!m.gone, cr: S(m.cr, 40), at: S(m.at, 40) };
      if (m._pw) clean._pw = m._pw;
      await putDoc(env, coll, id, clean);
      if (prev && clean.e && !clean.gone && clean.lock && !prev.lock)
        await sendLetter(env, clean.e, "Your account is paused", {
          title: "Your account is paused.",
          hello: `Hi ${firstName(clean.n)},`,
          paras: [`Your courses at ${brand(env)} are paused for now, so you won't be able to sign in for the moment.`, "If you think this is a mistake, or you have any questions, just reply to this email and we'll help."],
        });
      return;
    }
    case "lsub": { // a learner's own lesson progress: w = lessons ticked, p = progress per module
      if (!mine(ctx, id) || op === "delete") throw new HttpErr(403, "Not allowed");
      const m = merged();
      return putDoc(env, coll, id, { w: obj(m.w), p: obj(m.p) });
    }
    default: throw new HttpErr(403, "Not allowed"); // orders and leads are written by the server only
  }
}

export async function addDoc(env: Env, ctx: Ctx, coll: string, data: Doc) {
  if (!/^leads\/[A-Za-z0-9_-]{1,64}\/items$/.test(coll)) throw new HttpErr(403, "Not allowed");
  if (!sizeOk(data)) throw new HttpErr(413, "Too large");
  await limit(env, "lead:" + ctx.ip, 30, 3600_000);
  const id = crypto.randomUUID();
  const rec = { ...data, at: new Date().toISOString() };
  await putDoc(env, coll, id, rec);
  // every form is also emailed to the team inbox (logged until the mailbox settings are added)
  const to = env.NOTIFY_TO || env.SMTP_USER || "";
  const subject = S((rec as any).subject, 200) || `New ${S((rec as any).kind, 40)} form`;
  const lines = Object.entries(((rec as any).fields || {}) as Record<string, unknown>).map(([k, v]) => `${S(k, 90)}: ${S(v, 2000)}`);
  await sendLetter(env, to, subject, { title: subject, signoff: false, paras: lines.length ? lines.map((x) => x.replace(/^([^:]{1,90}):/, "**$1:**")) : ["(no fields)"], button: { label: "Open admin", url: `${siteUrl(env)}/admin` } });
  return id;
}
