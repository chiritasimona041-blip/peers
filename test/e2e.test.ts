import { env, SELF } from "cloudflare:test";
import { putDoc } from "../src/store";
import { nudgeUnpaid, studyReminders, dailySummary } from "../src/jobs";
import { describe, it, expect, beforeAll } from "vitest";

const BASE = "https://coaching.test";
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
class C {
  jar: Record<string, string> = {};
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await SELF.fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of (r.headers as any).getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j };
  }
  async login(e: string, pw: string) { return this.req("POST", "/api/login", { e, h: await sha(pw) }); }
  get(path: string) { return this.req("GET", "/api/db/doc?path=" + encodeURIComponent(path)); }
  set(path: string, data: any, op = "set") { return this.req("POST", "/api/db/doc", { path, data, op }); }
  list(coll: string, q = "") { return this.req("GET", "/api/db/list?coll=" + encodeURIComponent(coll) + q); }
}
const admin = new C(), jes = new C(), pau = new C();

beforeAll(async () => {
  for (const t of ["docs", "admins", "sessions", "login_attempts", "email_log"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const r = await new C().req("POST", "/api/setup", { email: "admin@coaching.test", name: "Ali", h: await sha("AdminPass123") }, { "X-Setup-Token": "test-setup-token" });
  expect(r.status).toBe(200);
});

describe("auth", () => {
  it("setup works once and needs the token", async () => {
    expect((await new C().req("POST", "/api/setup", { email: "x@x.io", h: await sha("x") }, { "X-Setup-Token": "test-setup-token" })).status).toBe(409);
    expect((await new C().req("POST", "/api/setup", { email: "x@x.io", h: await sha("x") })).status).toBe(403);
  });
  it("admin logs in, wrong password does not", async () => {
    expect((await new C().login("admin@coaching.test", "bad")).json.ok).toBe(false);
    const r = await admin.login("admin@coaching.test", "AdminPass123");
    expect(r.json).toMatchObject({ ok: true, role: "admin" });
    expect((await admin.req("GET", "/api/whoami")).json.role).toBe("admin");
  });
  it("passwords are stored hashed (PBKDF2), not as the client hash", async () => {
    const row = await env.DB.prepare("SELECT pw_hash,pw_salt FROM admins").first<any>();
    expect(row.pw_hash).not.toBe(await sha("AdminPass123"));
    expect(row.pw_hash).toHaveLength(64);
  });
  it("rate limits repeated wrong passwords", async () => {
    const c = new C(); let last: any;
    for (let i = 0; i < 10; i++) last = await c.login("brute@example.com", "no" + i);
    expect(last.status).toBe(429); // unknown emails are counted too
    const a = new C(); let s = 0;
    for (let i = 0; i < 10; i++) s = (await a.login("admin@coaching.test", "wrong" + i)).status;
    expect(s).toBe(429);
    await env.DB.prepare("DELETE FROM login_attempts").run();
  });
  it("cross-origin writes refused", async () => {
    expect((await admin.req("POST", "/api/db/doc", { path: "courses/x", data: {} }, { Origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("admin creates learners (as the admin page does)", () => {
  it("only admin can write lacct; password hash never comes back", async () => {
    const acct = { n: "Jesrel Test", e: "jesrel@example.com", c: ["a1"], lock: false, gone: false, sp: true, cr: new Date().toISOString(), h: await sha("Learner1234") };
    expect((await new C().set("lacct/jesrel_example_com", acct)).status).toBe(403);
    expect((await admin.set("lacct/jesrel_example_com", acct)).status).toBe(200);
    const g = (await admin.get("lacct/jesrel_example_com")).json;
    expect(g.data.n).toBe("Jesrel Test");
    expect(g.data.h).toBeUndefined(); expect(g.data._pw).toBeUndefined();
    const pa = { n: "Paula Paid", e: "paula@example.com", c: ["a1", "sy"], sp: false, cr: new Date().toISOString(), h: await sha("Paula1234") };
    expect((await admin.set("lacct/paula_example_com", pa)).status).toBe(200);
    expect((await admin.list("lacct")).json.docs.length).toBe(2);
  });
  it("no welcome email is sent when a learner is enrolled", async () => {
    const e = (await admin.req("GET", "/api/admin/emails")).json.emails;
    expect(e.filter((m: any) => m.subject.includes("Welcome")).length).toBe(0);
  });
  it("editing an account keeps the password working", async () => {
    const cur = (await admin.get("lacct/paula_example_com")).json.data;
    await admin.set("lacct/paula_example_com", { ...cur, n: "Paula P" });
    expect((await pau.login("paula@example.com", "Paula1234")).json.ok).toBe(true);
  });
  it("locked and removed accounts cannot log in", async () => {
    const cur = (await admin.get("lacct/paula_example_com")).json.data;
    await admin.set("lacct/paula_example_com", { ...cur, lock: true });
    const r = await new C().login("paula@example.com", "Paula1234");
    expect(r.json).toMatchObject({ ok: false, block: true, msg: "locked" });
    await admin.set("lacct/paula_example_com", { ...cur, lock: false });
    await admin.set("lacct/paula_example_com", { ...cur, gone: true });
    expect((await new C().login("paula@example.com", "Paula1234")).json.block).toBe(true);
    await admin.set("lacct/paula_example_com", { ...cur, gone: false });
  });
});

describe("learner can only touch their own data", () => {
  it("logs in and reads own account only", async () => {
    const r = await jes.login("jesrel@example.com", "Learner1234");
    expect(r.json).toMatchObject({ ok: true, role: undefined === 1 ? "x" : "learner", c: ["a1"] });
    expect((await jes.get("lacct/jesrel_example_com")).json.data.sp).toBeUndefined(); // no sponsored flag any more
    expect((await jes.get("lacct/paula_example_com")).status).toBe(403);
    expect((await jes.get("lacct/nobody_example_com")).status).toBe(403); // same answer whether or not it exists
    expect((await jes.list("lacct")).status).toBe(403);
  });
  it("saves progress in lsub, cannot write others or admin data", async () => {
    expect((await jes.set("lsub/jesrel_example_com", { w: { "a1:0:0:0": 1 }, n: "Jesrel", e: "jesrel@example.com" })).status).toBe(200);
    expect((await jes.get("lsub/jesrel_example_com")).json.data.w["a1:0:0:0"]).toBe(1);
    await jes.set("lsub/jesrel_example_com", { v: { u: "https://youtu.be/abc" } }, "update");
    const kept = (await jes.get("lsub/jesrel_example_com")).json.data;
    expect(kept.v).toBeUndefined(); expect(kept.w["a1:0:0:0"]).toBe(1); // progress only, no testimonial links
    expect((await jes.set("lsub/paula_example_com", { w: {} })).status).toBe(403);
    expect((await jes.set("lacct/jesrel_example_com", { sp: false })).status).toBe(403);
    expect((await jes.set("lunl/jesrel_example_com", { unlocked: true })).status).toBe(403);
    expect((await jes.set("courses/evil", { id: "evil" })).status).toBe(403);
  });
});

describe("courses", () => {
  it("admin saves a course, learners can read but not write, visitors cannot read", async () => {
    expect((await admin.set("courses/a1", { id: "a1", t: "CompTIA A+ Core 1", fl: 3, sections: [] })).status).toBe(200);
    expect((await jes.list("courses")).json.docs.length).toBe(1);
    expect((await new C().list("courses")).status).toBe(403);
    expect((await jes.set("courses/a1", { id: "a1" })).status).toBe(403);
  });
});

describe("leads", () => {
  it("Cyberally-only features are off; anyone can add a lead; only admin reads leads", async () => {
    const v = new C(); const who = (await v.req("GET", "/api/whoami")).json;
    expect((await v.set("chat/" + who.uid, { s: 1, n: "Pat", m: [] })).status).toBe(403);
    expect((await v.set("xprof/pat", { slug: "pat" })).status).toBe(403);
    expect((await admin.set("lunl/jesrel_example_com", { unlocked: true })).status).toBe(403);
    expect((await v.req("POST", "/api/db/add", { coll: "leads/" + who.uid + "/items", data: { kind: "contact", fields: { a: "b" } } })).status).toBe(200);
    expect((await v.list("leads/" + who.uid + "/items")).status).toBe(403);
    expect((await admin.list("leads/" + who.uid + "/items")).json.docs.length).toBe(1);
    const mails = (await admin.req("GET", "/api/admin/emails")).json.emails;
    expect(mails.some((m: any) => m.to_email === "info@coaching.test")).toBe(true);
  });
});

describe("session end", () => {
  it("logout ends the session", async () => {
    await jes.req("POST", "/api/logout", {});
    expect((await jes.get("lsub/jesrel_example_com")).status).toBe(403);
  });
});

describe("learner changes their own email", () => {
  it("needs the current password, refuses taken emails, and moves the account", async () => {
    const z = new C();
    await admin.set("lacct/zed_example_com", { n: "Zed", e: "zed@example.com", c: ["a1"], sp: false, cr: new Date().toISOString(), h: await sha("Zed12345") });
    expect((await z.login("zed@example.com", "Zed12345")).json.ok).toBe(true);
    expect((await z.set("lsub/zed_example_com", { p: { "a1:0:0": 80 } })).status).toBe(200);
    const h = await sha("Zed12345");
    expect((await z.req("POST", "/api/me/email", { e: "zed2@example.com", cur: await sha("wrong"), h })).status).toBe(403);
    expect((await z.req("POST", "/api/me/email", { e: "paula@example.com", cur: h, h })).status).toBe(409);
    expect((await z.req("POST", "/api/me/email", { e: "not-an-email", cur: h, h })).status).toBe(400);
    const ok = await z.req("POST", "/api/me/email", { e: "Zed2@Example.com", cur: h, h });
    expect(ok.status).toBe(200); expect(ok.json.e).toBe("zed2@example.com");
    expect((await z.req("GET", "/api/me")).json.e).toBe("zed2@example.com");
    expect((await new C().login("zed@example.com", "Zed12345")).json.ok).toBe(false);
    expect((await new C().login("zed2@example.com", "Zed12345")).json.ok).toBe(true);
    expect((await admin.get("lacct/zed_example_com")).json.exists).toBe(false);
    expect((await admin.get("lsub/zed2_example_com")).json.data.p["a1:0:0"]).toBe(80);
    expect((await admin.get("lsub/zed_example_com")).json.exists).toBe(false);
  });
});

describe("admin forgot password and mail check", () => {
  it("admin reset: token is created, password changes, old one stops working", async () => {
    const c = new C();
    expect((await c.req("POST", "/api/forgot", { e: "admin@coaching.test" })).json.ok).toBe(true);
    const mail = await env.DB.prepare("SELECT to_email,body FROM email_log WHERE subject LIKE 'Reset%' ORDER BY id DESC").first<any>();
    expect(mail.to_email).toBe("admin@coaching.test");
    const t = String(mail.body).match(/t=([0-9a-f]{64})/)![1];
    expect((await c.req("GET", "/api/reset/check?t=" + t)).json.ok).toBe(true);
    expect((await c.req("POST", "/api/reset", { t, h: await sha("admin@coaching.test|NewAdminPass9") })).json.ok).toBe(true);
    expect((await new C().req("POST", "/api/login", { e: "admin@coaching.test", h: await sha("admin@coaching.test|AdminPass123") })).json.ok).toBe(false);
    expect((await new C().req("POST", "/api/login", { e: "admin@coaching.test", h: await sha("admin@coaching.test|NewAdminPass9") })).json.role).toBe("admin");
    expect((await c.req("POST", "/api/reset", { t, h: await sha("x") })).status).toBeGreaterThanOrEqual(400);
  });
  it("mail-check is admin only and reports missing settings", async () => {
    expect((await new C().req("GET", "/api/admin/mail-check")).status).toBe(403);
    const a = new C();
    await a.req("POST", "/api/login", { e: "admin@coaching.test", h: await sha("admin@coaching.test|NewAdminPass9") });
    const r = await a.req("GET", "/api/admin/mail-check");
    expect(r.status).toBe(200);
    expect(r.json.config.SMTP_PASS).toBe(false);
    expect(r.json.config).toHaveProperty("SMTP_PASS");
  });
  it("mail-resend is admin only", async () => {
    expect((await new C().req("GET", "/api/admin/mail-resend")).status).toBe(403);
    const a = new C();
    await a.req("POST", "/api/login", { e: "admin@coaching.test", h: await sha("admin@coaching.test|NewAdminPass9") });
    const r = await a.req("GET", "/api/admin/mail-resend");
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty("resent");
  });
});

describe("online enrolment, exam and certificate", () => {
  const signed = async (payload: unknown, secret = "whsec_test", at = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(payload);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${raw}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return SELF.fetch(BASE + "/api/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${at},v1=${sig}` }, body: raw });
  };
  const order = "11111111-2222-4333-8444-555555555555";
  const paidEvent = (amount = 14900) => ({ type: "checkout.session.completed", data: { object: { payment_status: "paid", amount_total: amount, currency: "gbp", metadata: { order } } } });
  const nia = new C();
  let certNo = "";
  const adm = new C();
  beforeAll(async () => {
    // the admin password was changed by the reset test above
    const r = await adm.req("POST", "/api/login", { e: "admin@coaching.test", h: await sha("admin@coaching.test|NewAdminPass9") });
    expect(r.json.role).toBe("admin");
  });

  it("the catalogue is public and shows no lessons or answers", async () => {
    await adm.set("courses/life", { title: "Certified Life Coach", tag: "Core", blurb: "Start here.", price: 14900, modules: [{ title: "M1", lessons: [{ title: "L1", body: "secret lesson", url: "https://content.example/M1/story.html" }] }] });
    await adm.set("courses/draft", { title: "Not ready", price: 9900, live: false });
    await adm.set("exams/life", { q: [0, 1, 2, 3, 4].map((i) => ({ q: "Q" + i, o: ["a", "b", "c"], a: 1 })) });
    const r = await new C().req("GET", "/api/catalogue");
    const life = r.json.courses.find((x: any) => x.id === "life");
    expect(life).toMatchObject({ title: "Certified Life Coach", price: 14900, modules: 1 });
    expect(JSON.stringify(r.json)).not.toContain("secret lesson");
    expect(JSON.stringify(r.json)).not.toContain("content.example");
    expect(r.json.courses.some((x: any) => x.id === "draft")).toBe(false);
    expect((await new C().get("exams/life")).status).toBe(403);
    expect((await jes.get("exams/life")).status).toBe(403);
  });
  it("enrol checks its input and never gives a course away while payment is off", async () => {
    const v = new C();
    expect((await v.req("POST", "/api/enrol", { course: "life", n: "", e: "nia@example.com" })).status).toBe(400);
    expect((await v.req("POST", "/api/enrol", { course: "life", n: "Nia", e: "nope" })).status).toBe(400);
    expect((await v.req("POST", "/api/enrol", { course: "draft", n: "Nia", e: "nia@example.com" })).status).toBe(404);
    expect((await v.req("POST", "/api/enrol", { course: "life", n: "Nia", e: "nia@example.com" })).status).toBe(503);
    expect((await adm.get("lacct/nia_example_com")).json.exists).toBe(false);
  });
  it("only a correctly signed, correctly priced payment opens the account", async () => {
    await env.DB.prepare("INSERT INTO docs (coll,id,data,upd) VALUES ('orders',?,?,?)").bind(order, JSON.stringify({ course: "life", title: "Certified Life Coach", n: "Nia New", e: "nia@example.com", amount: 14900, cur: "gbp", status: "pending" }), Date.now()).run();
    expect((await signed(paidEvent(), "wrong_secret")).status).toBe(400);
    expect((await signed(paidEvent(), "whsec_test", Math.floor(Date.now() / 1000) - 4000)).status).toBe(400);
    expect((await signed(paidEvent(100))).status).toBe(200); // underpaid: accepted by the endpoint, not fulfilled
    expect((await adm.get("lacct/nia_example_com")).json.exists).toBe(false);
    expect((await new C().req("GET", "/api/order?o=" + order)).json.paid).toBe(false);
    expect((await signed(paidEvent())).status).toBe(200);
    expect((await signed(paidEvent())).status).toBe(200); // Stripe may send it twice
    const a = (await adm.get("lacct/nia_example_com")).json.data;
    expect(a).toMatchObject({ n: "Nia New", c: ["life"] });
    expect((await new C().req("GET", "/api/order?o=" + order)).json.paid).toBe(true);
    const mails = (await adm.req("GET", "/api/admin/emails")).json.emails;
    expect(mails.filter((m: any) => m.to_email === "nia@example.com" && m.subject.includes("set your password")).length).toBe(1);
    expect(mails.some((m: any) => m.to_email === "info@coaching.test" && m.subject.startsWith("New enrolment"))).toBe(true);
  });
  it("the learner sets a password from the email link and sees only the course they bought", async () => {
    const mail = (await adm.req("GET", "/api/admin/emails")).json.emails.find((m: any) => m.to_email === "nia@example.com" && m.subject.includes("set your password"));
    const tok = /set-password\?t=([0-9a-f]{64})/.exec(mail.body)![1];
    expect((await new C().req("POST", "/api/reset", { t: tok, h: await sha("NiaPass123") })).json.ok).toBe(true);
    expect((await nia.login("nia@example.com", "NiaPass123")).json.ok).toBe(true);
    expect((await nia.list("courses")).json.docs.map((d: any) => d.id)).toEqual(["life"]);
    expect((await nia.get("courses/a1")).status).toBe(403);
    expect((await nia.get("courses/life")).json.data.modules[0].lessons[0].body).toBe("secret lesson");
    expect((await nia.get("courses/life")).json.data.modules[0].lessons[0].url).toBe("https://content.example/M1/story.html");
  });
  it("the exam hides its answers, fails below the pass mark and can be retaken", async () => {
    const shut = (await nia.req("GET", "/api/exam?course=life")).json;
    expect(shut).toMatchObject({ locked: true, questions: [] }); // every module must be ticked first
    expect((await nia.req("POST", "/api/exam/submit", { course: "life", answers: [1, 1, 1, 1, 1] })).status).toBe(403);
    expect((await nia.set("lsub/nia_example_com", { w: { "life:0:0": 1 } })).status).toBe(200);
    const ex = (await nia.req("GET", "/api/exam?course=life")).json;
    expect(ex.locked).toBe(false); expect(ex.questions.length).toBe(5); expect(ex.pass).toBe(80);
    expect(JSON.stringify(ex.questions)).not.toContain('"a":');
    expect((await nia.req("GET", "/api/exam?course=a1")).status).toBe(403);
    expect((await new C().req("GET", "/api/exam?course=life")).status).toBe(401);
    const fail = (await nia.req("POST", "/api/exam/submit", { course: "life", answers: [1, 1, 1, 0, 0] })).json;
    expect(fail).toMatchObject({ pct: 60, passed: false, cert: "" });
    expect((await nia.req("GET", "/api/certificates")).json.certificates.length).toBe(0);
    const pass = (await nia.req("POST", "/api/exam/submit", { course: "life", answers: [1, 1, 1, 1, 0] })).json;
    expect(pass).toMatchObject({ pct: 80, passed: true });
    certNo = pass.cert; expect(certNo).toMatch(/^TPC-[A-Z2-9]{8}$/);
    const again = (await nia.req("POST", "/api/exam/submit", { course: "life", answers: [1, 1, 1, 1, 1] })).json;
    expect(again.cert).toBe(certNo); // one certificate per certification
    expect((await nia.req("GET", "/api/certificates")).json.certificates).toMatchObject([{ no: certNo, n: "Nia New", title: "Certified Life Coach" }]);
  });
  it("anyone can verify a real certificate; a revoked or made-up one fails", async () => {
    const v = new C();
    expect((await v.req("GET", "/api/verify?no=" + certNo.toLowerCase())).json).toMatchObject({ ok: true, n: "Nia New", title: "Certified Life Coach" });
    expect((await v.req("GET", "/api/verify?no=TPC-AAAAAAAA")).json.ok).toBe(false);
    expect((await nia.set("certs/" + certNo, { revoked: false })).status).toBe(403);
    expect((await adm.set("certs/" + certNo, { revoked: true }, "update")).status).toBe(200);
    expect((await v.req("GET", "/api/verify?no=" + certNo)).json.ok).toBe(false);
    expect((await adm.set("certs/TPC-FAKE0000", { n: "Fake" })).status).toBe(403); // certificates cannot be typed in by hand
  });
  it("certificates and exam results follow a learner who changes their email", async () => {
    expect((await adm.set("certs/" + certNo, { revoked: false }, "update")).status).toBe(200);
    const h = await sha("NiaPass123");
    expect((await nia.req("POST", "/api/me/email", { e: "nia2@example.com", cur: h, h })).status).toBe(200);
    expect((await nia.req("GET", "/api/certificates")).json.certificates).toMatchObject([{ no: certNo }]);
    expect((await nia.req("GET", "/api/exam?course=life")).json).toMatchObject({ passed: true, cert: certNo });
  });
  it("admin can change the price, the was price and the currency", async () => {
    expect((await adm.set("courses/life", { price: 19900, was: 29900, cur: "gbp" }, "update")).status).toBe(200);
    let life = (await new C().req("GET", "/api/catalogue")).json.courses.find((x: any) => x.id === "life");
    expect(life).toMatchObject({ price: 19900, was: 29900, cur: "gbp", title: "Certified Life Coach" });
    await adm.set("courses/life", { was: 0 }, "update");
    life = (await new C().req("GET", "/api/catalogue")).json.courses.find((x: any) => x.id === "life");
    expect(life.was).toBe(0);
  });
  it("each certification address carries its own title and description; an unknown one is a 404", async () => {
    const r = await SELF.fetch("https://example.com/certified-life-coach");
    const html = await r.text();
    expect(r.status).toBe(200); expect(html).toContain("<title>Certified Life Coach | The Peers Certification</title>");
    expect(html).toContain('"@type":"Course"'); expect(html).not.toContain("content.example");
    expect((await SELF.fetch("https://example.com/certified-nope")).status).toBe(404);
  });
  it("timed jobs: one reminder for an unpaid enrolment, study reminders that respect the off switch, and a daily summary", async () => {
    const now = Date.now(), H = 3600e3, D = 24 * H;
    const mails = async (to: string) => (await adm.req("GET", "/api/admin/emails")).json.emails.filter((m: any) => m.to_email === to);
    const order = { course: "life", title: "Certified Life Coach", n: "Una Unpaid", e: "una@example.com", amount: 19900, cur: "gbp", status: "pending", at: new Date(now - 2 * H).toISOString() };
    await putDoc(env as any, "orders", "00000000-0000-4000-8000-000000000001", order);
    await putDoc(env as any, "orders", "00000000-0000-4000-8000-000000000002", { ...order, at: new Date(now - 10 * 60e3).toISOString(), e: "toosoon@example.com" });
    expect(await nudgeUnpaid(env as any, now)).toBe(1);
    expect(await nudgeUnpaid(env as any, now)).toBe(0); // never twice
    const una = await mails("una@example.com");
    expect(una.length).toBe(1); expect(una[0].body).toContain("/certified-life-coach");
    expect((await mails("toosoon@example.com")).length).toBe(0);

    await putDoc(env as any, "lacct", "quiet_example_com", { n: "Quinn Quiet", e: "quiet@example.com", c: ["life"], lock: false, gone: false, at: new Date(now - 10 * D).toISOString() });
    await putDoc(env as any, "lacct", "off_example_com", { n: "Olly Off", e: "off@example.com", c: ["life"], lock: false, gone: false, rem: false, at: new Date(now - 10 * D).toISOString() });
    expect(await studyReminders(env as any, now)).toBeGreaterThanOrEqual(1);
    const q = await mails("quiet@example.com");
    expect(q.length).toBe(1); expect(q[0].body).toContain("Module 1");
    expect((await mails("off@example.com")).length).toBe(0);
    expect((await mails("nia.new@example.com")).length + (await mails("nia@example.com")).filter((m: any) => m.subject === "Your next module is ready").length).toBe(0); // already certified
    await studyReminders(env as any, now + D);
    expect((await mails("quiet@example.com")).length).toBe(1); // not again within 14 days

    expect(await dailySummary({ ...(env as any), NOTIFY_TO: "" , SMTP_USER: "" }, now)).toBe(false);
    expect(await dailySummary({ ...(env as any), NOTIFY_TO: "team@example.com" }, now)).toBe(true);
    const sum = (await mails("team@example.com")).find((m: any) => m.subject.includes("last 24 hours"));
    expect(sum.body).toContain("Enrolments paid: 1 (149.00 GBP)"); expect(sum.body).toMatch(/Enrolments started and not paid: [2-9]/);
  });
  it("there is no expert login or sponsored flag left", async () => {
    const who = (await nia.req("GET", "/api/whoami")).json;
    expect(who.role).toBe("learner"); expect(who.slug).toBeUndefined();
    await adm.set("lacct/sam_example_com", { n: "Sam", e: "sam@example.com", c: ["life"], sp: true, h: await sha("SamPass123") });
    expect((await adm.get("lacct/sam_example_com")).json.data.sp).toBeUndefined();
  });
});
