// Enrolment (straight to payment, no basket), final exam, certificates and public verification.
import type { Hono, Context } from "hono";
import { brand, sendMail, sendLetter, firstName, type Env } from "./mail";
import type { Ctx } from "./rules";
import { getDoc, putDoc, listDocs, type Doc } from "./store";
import { sha256, newToken } from "./crypto";
import { HttpErr, S, lmKey } from "./util";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COURSE_ID = /^[A-Za-z0-9-]{1,24}$/;
const SET_PW_MS = 7 * 864e5;
const passMark = (env: Env, exam?: Doc | null) => Math.min(100, Math.max(1, Number(exam?.pass ?? env.PASS_MARK ?? 80) || 80));
// Stripe keys with any stray spaces or line breaks from copy and paste removed
const stripeKey = (env: Env) => String(env.STRIPE_SECRET_KEY || "").trim();
const origin = (c: Context) => String(c.env.SITE_ORIGIN || "").replace(/\/+$/, "") || new URL(c.req.url).origin;

async function hit(env: Env, k: string, max: number, windowMs: number) {
  const r = await env.DB.prepare("SELECT COUNT(*) n FROM login_attempts WHERE k=? AND at>?").bind(k, Date.now() - windowMs).first<{ n: number }>();
  if ((r?.n ?? 0) >= max) throw new HttpErr(429, "Too many tries. Please wait a few minutes.");
  await env.DB.prepare("INSERT INTO login_attempts (k,at) VALUES (?,?)").bind(k, Date.now()).run();
}
async function json(c: Context): Promise<Record<string, any>> {
  try { const j = await c.req.json(); if (j && typeof j === "object") return j; } catch {}
  throw new HttpErr(400, "Invalid JSON");
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
const sameStr = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/** A real, dated offer from the site settings (OFFER_PCT, OFFER_UNTIL). It is simply off before setup and after its end date,
 *  so the price on the page, at checkout and in Stripe always goes back to the full price when the countdown ends. */
export type Offer = { pct: number; until: string } | null;
export function offerNow(env: Env, now = Date.now()): Offer {
  const pct = Number(env.OFFER_PCT || 0), until = Date.parse(String(env.OFFER_UNTIL || ""));
  return Number.isFinite(pct) && pct > 0 && pct < 90 && Number.isFinite(until) && until > now ? { pct, until: new Date(until).toISOString() } : null;
}
/** What the buyer pays now: the offer price, rounded down to a whole unit (e.g. $206.50 -> $206), or the full price. */
export const payPrice = (price: number, offer: Offer) => (offer ? Math.floor((price * (100 - offer.pct)) / 10000) * 100 : price);
const guaranteeDays = (env: Env) => { const n = Number(env.GUARANTEE_DAYS || 0); return Number.isInteger(n) && n > 0 && n <= 60 ? n : 0; };

// What a visitor may see of a course: never lessons, never exam answers.
const publicCourse = (id: string, d: Doc, offer: Offer = null, guarantee = 0) => ({
  id, title: S(d.title, 120), tag: S(d.tag, 40), blurb: S(d.blurb, 400),
  price: payPrice(Number(d.price) || 0, offer), full: Number(d.price) || 0, cur: S(d.cur, 3) || "",
  modules: Array.isArray(d.modules) ? d.modules.length : 0,
  outline: (Array.isArray(d.modules) ? d.modules : []).slice(0, 40).map((m: Doc) => ({ title: S(m?.title, 120), lessons: Array.isArray(m?.lessons) ? m.lessons.length : 0 })),
  learn: (Array.isArray(d.learn) ? d.learn : []).slice(0, 12).map((x: unknown) => S(x, 200)),
  img: /^[a-z]{1,20}$/.test(String(d.img)) ? String(d.img) : "", featured: !!d.featured,
  sub: S(d.sub, 60), was: offer ? Number(d.price) || 0 : 0, offer, guarantee, care: !!d.care,
  who: (Array.isArray(d.who) ? d.who : []).slice(0, 6).map((x: unknown) => S(x, 120)),
  slug: slugOf(d.title),
  // optional long-form landing page content, written by an admin
  page: d.page && typeof d.page === "object" && JSON.stringify(d.page).length < 40000 ? d.page : null,
});
const escHtml = (v: string) => v.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
/** The certification page with its own title and description in the HTML, so search engines and link previews can read it. */
export async function coursePage(c: Context, slug: string): Promise<Response> {
  const rows = await listDocs(c.env, "courses");
  const row = rows.find((r) => forSale(r.data) && slugOf(r.data.title) === slug);
  if (!row) { const nf = await c.env.ASSETS.fetch(new Request(new URL("/404.html", c.req.url))); return new Response(nf.body, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }); }
  const offer = offerNow(c.env), d = publicCourse(row.id, row.data, offer, guaranteeDays(c.env)), b = brand(c.env), url = origin(c) + "/" + slug;
  const page = await c.env.ASSETS.fetch(new Request(new URL("/certification/", c.req.url)));
  const desc = escHtml(S(String((d.page as Doc | null)?.lede || d.blurb), 300));
  const ld = { "@context": "https://schema.org", "@type": "Course", name: d.title, description: S(String((d.page as Doc | null)?.lede || d.blurb), 300), url, provider: { "@type": "Organization", name: b, url: origin(c) },
    offers: { "@type": "Offer", price: (d.price / 100).toFixed(2), priceCurrency: (d.cur || String(c.env.CURRENCY || "gbp")).toUpperCase(), url, category: "Paid", ...(offer ? { priceValidUntil: offer.until.slice(0, 10) } : {}) } };
  const head = `<title>${escHtml(d.title)} | ${escHtml(b)}</title>\n<meta name="description" content="${desc}">\n<link rel="canonical" href="${escHtml(url)}">\n<meta property="og:type" content="website">\n<meta property="og:title" content="${escHtml(d.title)}">\n<meta property="og:description" content="${desc}">\n<meta property="og:url" content="${escHtml(url)}">` +
    (d.img ? `\n<meta property="og:image" content="${escHtml(origin(c))}/img/${d.img}.jpg">` : "") + `\n<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
  const html = (await page.text()).replace(/<title>[^<]*<\/title>\s*<meta name="description"[^>]*>/, () => head);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
export const slugOf = (title: unknown) => S(title, 120).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const forSale = (d: Doc | null) => !!d && d.live !== false && Number.isInteger(d.price) && d.price > 0;

/** Marks an order paid, gives the learner the course and emails their way in. Safe to call twice. */
export async function fulfil(env: Env, orderId: string, siteOrigin: string) {
  const o = await getDoc(env, "orders", orderId);
  if (!o) return false;
  if (o.status === "paid") return true;
  const key = lmKey(o.e);
  const b = brand(env);
  let a = await getDoc(env, "lacct", key);
  const isNew = !a;
  if (!a) a = { n: S(o.n, 80), e: S(o.e, 120), c: [], lock: false, gone: false, cr: "online", at: new Date().toISOString() };
  if (!a.c.includes(o.course)) a.c = [...a.c, o.course].slice(0, 60);
  await putDoc(env, "lacct", key, a);
  await putDoc(env, "orders", orderId, { ...o, status: "paid", paidAt: new Date().toISOString() });
  if (!a._pw) {
    const token = newToken();
    await putDoc(env, "rtok", await sha256(token), { k: key, kind: "l", exp: Date.now() + SET_PW_MS });
    await sendLetter(env, a.e, `Welcome to ${o.title}`, {
      title: `Welcome, ${firstName(a.n)}.`,
      preheader: "Choose your password and start module 1 today.",
      paras: [`You're enrolled on **${o.title}**, and your place is ready.`, "Choose a password to open your account. It takes a few seconds, and then you can start module 1 straight away."],
      button: { label: "Choose my password", url: `${siteOrigin}/set-password?t=${token}` },
      bullets: ["Study online, at your own pace, on any device", "12 months of access to every module", "A final exam and a certificate anyone can verify"],
      after: ["This link works once and stays valid for 7 days. If it runs out, use “Forgot your password?” on the sign-in page."],
      small: `You're receiving this because you enrolled at ${b}.`,
    });
  } else {
    await sendLetter(env, a.e, `${o.title} is now in your account`, {
      title: `It's ready, ${firstName(a.n)}.`,
      preheader: "Sign in and start module 1 whenever you like.",
      paras: [`**${o.title}** has been added to your account, next to your other courses.`, "Sign in whenever you're ready and start with module 1."],
      button: { label: "Sign in and start", url: `${siteOrigin}/login` },
      small: `You're receiving this because you enrolled at ${b}.`,
    });
  }
  const team = env.NOTIFY_TO || env.SMTP_USER || "";
  if (team) await sendLetter(env, team, `New enrolment: ${o.title}`, {
    title: "New enrolment", signoff: false,
    paras: [`**${a.n}** (${a.e}) enrolled on **${o.title}**.`, `Paid: **${(o.amount / 100).toFixed(2)} ${String(o.cur).toUpperCase()}** · ${isNew ? "New learner" : "Existing learner"}`],
    button: { label: "Open admin", url: `${siteOrigin}/admin` },
  });
  return true;
}

export function registerShop(app: Hono<any>) {
  // ---------- public catalogue ----------
  app.get("/api/catalogue", async (c) => {
    const rows = await listDocs(c.env, "courses"), offer = offerNow(c.env), guarantee = guaranteeDays(c.env);
    return c.json({ courses: rows.filter((r) => forSale(r.data)).map((r) => publicCourse(r.id, r.data, offer, guarantee)).sort((x, y) => Number(y.featured) - Number(x.featured) || x.title.localeCompare(y.title)) });
  });

  // ---------- enrol: name + email, then straight to payment ----------
  app.post("/api/enrol", async (c) => {
    const ctx = c.get("ctx") as Ctx;
    const b = await json(c);
    const course = String(b.course || ""), n = S(b.n, 80).trim(), e = S(b.e, 120).trim().toLowerCase();
    if (!COURSE_ID.test(course)) throw new HttpErr(400, "Please choose a certification.");
    if (!n) throw new HttpErr(400, "Please add your name.");
    if (!EMAIL.test(e) || !lmKey(e)) throw new HttpErr(400, "Please enter a valid email address.");
    const d = await getDoc(c.env, "courses", course);
    if (!forSale(d)) throw new HttpErr(404, "That certification is not open for enrolment.");
    const acct = await getDoc(c.env, "lacct", lmKey(e));
    if (acct && !acct.gone && Array.isArray(acct.c) && acct.c.includes(course)) throw new HttpErr(409, "You are already enrolled on this certification. Please sign in.");
    if (!stripeKey(c.env)) throw new HttpErr(503, "Online payment is not switched on yet.");
    await hit(c.env, "enrol:" + ctx.ip, 20, 3600_000);
    const id = crypto.randomUUID();
    const cur = (S(d!.cur, 3) || c.env.CURRENCY || "gbp").toLowerCase();
    const amount = payPrice(d!.price, offerNow(c.env)); // the price shown on the page right now
    const o: Doc = { course, title: S(d!.title, 120), n, e, amount, cur, status: "pending", at: new Date().toISOString() };
    const base = origin(c);
    const form = new URLSearchParams({
      mode: "payment", customer_email: e, client_reference_id: id,
      success_url: `${base}/welcome?o=${id}`, cancel_url: `${base}/${slugOf(d!.title) || "certifications"}`,
      "metadata[order]": id,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": cur,
      "line_items[0][price_data][unit_amount]": String(amount),
      "line_items[0][price_data][product_data][name]": o.title,
    });
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${stripeKey(c.env)}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const s: any = await r.json().catch(() => null);
    if (!r.ok || !s?.url) { console.log("stripe session failed", r.status, s?.error?.message); throw new HttpErr(502, "We could not open the payment page. Please try again."); }
    await putDoc(c.env, "orders", id, { ...o, sid: S(s.id, 120) });
    return c.json({ ok: true, url: s.url });
  });

  // ---------- Stripe tells us the payment went through ----------
  app.post("/api/stripe/webhook", async (c) => {
    const secret = String(c.env.STRIPE_WEBHOOK_SECRET || "").trim();
    if (!secret) throw new HttpErr(503, "Not configured");
    const raw = await c.req.text();
    const sig = c.req.header("Stripe-Signature") || "";
    const t = /(?:^|,)t=(\d+)/.exec(sig)?.[1];
    const v1 = [...sig.matchAll(/(?:^|,)v1=([0-9a-f]{64})/g)].map((m) => m[1]);
    if (!t || !v1.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new HttpErr(400, "Bad signature");
    const want = await hmacHex(secret, `${t}.${raw}`);
    if (!v1.some((x) => sameStr(x, want))) throw new HttpErr(400, "Bad signature");
    let ev: any = null; try { ev = JSON.parse(raw); } catch {}
    if (ev?.type === "checkout.session.completed" && ev.data?.object?.payment_status === "paid") {
      const s = ev.data.object;
      const id = String(s.metadata?.order || s.client_reference_id || "");
      const o = /^[0-9a-f-]{36}$/.test(id) ? await getDoc(c.env, "orders", id) : null;
      // only fulfil when the amount Stripe took is the amount we asked for
      if (o && Number(s.amount_total) === Number(o.amount) && String(s.currency).toLowerCase() === o.cur) await fulfil(c.env, id, origin(c));
    }
    return c.json({ received: true });
  });

  // Admin-only: what Stripe says about an order, and why it was or was not completed. Completes it when everything matches.
  app.get("/api/admin/order-check", async (c) => {
    if ((c.get("ctx") as Ctx).role !== "admin") throw new HttpErr(403, "Not allowed");
    const id = String(c.req.query("o") || "");
    const o = /^[0-9a-f-]{36}$/.test(id) ? await getDoc(c.env, "orders", id) : null;
    if (!o) return c.json({ error: "No such order" }, 404);
    if (!o.sid) return c.json({ order: { status: o.status }, problem: "This order never reached Stripe checkout." });
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(String(o.sid))}`, { headers: { Authorization: `Bearer ${stripeKey(c.env)}` } }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(e) } }) }) as any);
    const s: any = await r.json().catch(() => null);
    if (!r.ok) return c.json({ order: { status: o.status, session: String(o.sid).slice(0, 8) }, stripe_error: { http: r.status, message: s?.error?.message || "no answer" } });
    const checks = {
      payment_status: s.payment_status, status: s.status,
      this_order: s.metadata?.order === id || s.client_reference_id === id,
      amount_stripe: s.amount_total, amount_order: o.amount, amount_matches: Number(s.amount_total) === Number(o.amount),
      currency_stripe: s.currency, currency_order: o.cur, currency_matches: String(s.currency).toLowerCase() === o.cur,
    };
    const ok = checks.payment_status === "paid" && checks.this_order && checks.amount_matches && checks.currency_matches;
    if (ok && o.status !== "paid") await fulfil(c.env, id, origin(c));
    const after = await getDoc(c.env, "orders", id);
    return c.json({ order_status_now: after?.status, completed_now: ok && o.status !== "paid", checks });
  });

  // the thank-you page asks whether the payment has landed yet
  // and if the webhook has not arrived yet, we ask Stripe ourselves, so the buyer never waits on it
  app.get("/api/order", async (c) => {
    const id = String(c.req.query("o") || "");
    let o = /^[0-9a-f-]{36}$/.test(id) ? await getDoc(c.env, "orders", id) : null;
    if (o && o.status !== "paid" && o.sid && stripeKey(c.env)) {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(String(o.sid))}`, { headers: { Authorization: `Bearer ${stripeKey(c.env)}` } }).catch(() => null);
      const s: any = r && r.ok ? await r.json().catch(() => null) : null;
      // the same checks as the webhook: paid, this order, and exactly the amount and currency we asked for
      if (s && s.payment_status === "paid" && (s.metadata?.order === id || s.client_reference_id === id) && Number(s.amount_total) === Number(o.amount) && String(s.currency).toLowerCase() === o.cur) {
        await fulfil(c.env, id, origin(c));
        o = await getDoc(c.env, "orders", id);
      }
    }
    return c.json(o ? { ok: true, paid: o!.status === "paid", title: o!.title } : { ok: false });
  });

  // ---------- final exam ----------
  const learner = async (c: Context, course: string) => {
    const x = c.get("ctx") as Ctx;
    if (x.role !== "learner" || !x.key) throw new HttpErr(401, "Please sign in again");
    if (!COURSE_ID.test(course)) throw new HttpErr(400, "Bad course");
    const a = await getDoc(c.env, "lacct", x.key);
    if (!a || a.gone || a.lock || !Array.isArray(a.c) || !a.c.includes(course)) throw new HttpErr(403, "You are not enrolled on this certification.");
    return { x, a };
  };
  // The exam opens once every lesson of the course is ticked off. A course with no lessons loaded has nothing to finish.
  const finished = async (env: Env, key: string, course: string) => {
    const cd = await getDoc(env, "courses", course);
    const done = ((await getDoc(env, "lsub", key)) || {}).w || {};
    return (Array.isArray(cd?.modules) ? cd!.modules : []).every((m: Doc, mi: number) => (Array.isArray(m?.lessons) ? m.lessons : []).every((_: unknown, li: number) => !!done[`${course}:${mi}:${li}`]));
  };
  const questions = (exam: Doc | null) => (Array.isArray(exam?.q) ? exam!.q : []).filter((q: Doc) => q && Array.isArray(q.o) && q.o.length >= 2 && Number.isInteger(q.a) && q.a >= 0 && q.a < q.o.length);

  app.get("/api/exam", async (c) => {
    const course = String(c.req.query("course") || "");
    const { x } = await learner(c, course);
    const exam = await getDoc(c.env, "exams", course);
    const rec = (await getDoc(c.env, "lexam", `${x.key}--${course}`)) || {};
    const locked = !rec.cert && !(await finished(c.env, x.key!, course));
    return c.json({
      locked, ready: questions(exam).length > 0,
      questions: locked ? [] : questions(exam).map((q: Doc) => ({ q: S(q.q, 600), o: q.o.map((o: unknown) => S(o, 300)) })),
      pass: passMark(c.env, exam), attempts: rec.tries || 0, best: rec.best || 0, passed: !!rec.cert, cert: rec.cert || "",
    });
  });

  app.post("/api/exam/submit", async (c) => {
    const b = await json(c);
    const course = String(b.course || "");
    const { x, a } = await learner(c, course);
    const exam = await getDoc(c.env, "exams", course);
    const qs = questions(exam);
    if (!qs.length) throw new HttpErr(404, "The exam for this certification is not ready yet.");
    if (!(await finished(c.env, x.key!, course))) throw new HttpErr(403, "Complete every module before you take the final exam.");
    await hit(c.env, `exam:${x.key}:${course}`, 10, 3600_000);
    const ans = Array.isArray(b.answers) ? b.answers : [];
    let right = 0;
    qs.forEach((q: Doc, i: number) => { if (Number(ans[i]) === q.a) right++; });
    const pct = Math.round((right / qs.length) * 100);
    const mark = passMark(c.env, exam);
    const passed = pct >= mark;
    const id = `${x.key}--${course}`;
    const rec = (await getDoc(c.env, "lexam", id)) || {};
    let cert = S(rec.cert, 40);
    if (passed && !cert) {
      const courseDoc = await getDoc(c.env, "courses", course);
      const title = S(courseDoc?.title, 120) || course;
      const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      for (let tries = 0; tries < 5 && !cert; tries++) {
        const rnd = crypto.getRandomValues(new Uint8Array(8));
        const no = `${S(c.env.CERT_PREFIX, 6) || "TPC"}-${[...rnd].map((v) => abc[v % abc.length]).join("")}`;
        if (!(await getDoc(c.env, "certs", no))) {
          await putDoc(c.env, "certs", no, { no, k: x.key, n: S(a.n, 80), course, title, pct, at: new Date().toISOString() });
          cert = no;
        }
      }
      if (!cert) throw new HttpErr(500, "Server error");
      const bn = brand(c.env);
      const job = sendLetter(c.env, S(a.e, 120), `Congratulations: you passed ${title}`, {
        title: `You did it, ${firstName(a.n)}.`,
        preheader: `You're now certified: ${title}.`,
        paras: [`You scored **${pct}%** on the final exam, and you are now certified: **${title}**.`, "Your certificate is ready to download whenever you like."],
        box: { label: "Certificate number", value: cert },
        button: { label: "Download my certificate", url: `${origin(c)}/login` },
        after: [`Anyone can check your certificate at ${origin(c).replace(/^https?:\/\//, "")}/verify using the number above. Add it to your website, LinkedIn profile or CV.`],
        small: `You're receiving this because you passed a final exam at ${bn}.`,
      });
      try { c.executionCtx.waitUntil(job); } catch { await job; }
    }
    await putDoc(c.env, "lexam", id, { ...rec, k: x.key, course, tries: (rec.tries || 0) + 1, best: Math.max(rec.best || 0, pct), last: pct, cert, at: new Date().toISOString() });
    return c.json({ ok: true, right, total: qs.length, pct, pass: mark, passed, cert });
  });

  app.get("/api/certificates", async (c) => {
    const x = c.get("ctx") as Ctx;
    if (x.role !== "learner" || !x.key) throw new HttpErr(401, "Please sign in again");
    const rows = await listDocs(c.env, "certs", { field: "k", value: x.key });
    return c.json({ certificates: rows.filter((r) => !r.data.revoked).map((r) => ({ no: r.data.no, n: r.data.n, course: r.data.course, title: r.data.title, at: r.data.at })) });
  });

  // ---------- anyone can check a certificate number ----------
  app.get("/api/verify", async (c) => {
    const ctx = c.get("ctx") as Ctx;
    await hit(c.env, "verify:" + ctx.ip, 30, 15 * 60_000);
    const no = String(c.req.query("no") || "").trim().toUpperCase();
    const d = /^[A-Z0-9]{1,6}-[A-Z0-9]{8}$/.test(no) ? await getDoc(c.env, "certs", no) : null;
    if (!d || d.revoked) return c.json({ ok: false });
    return c.json({ ok: true, no: d.no, n: d.n, title: d.title, at: d.at });
  });
}
