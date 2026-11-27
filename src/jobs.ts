// Timed jobs, run by the hourly schedule in wrangler.toml: a single reminder for an unfinished enrolment,
// study reminders for learners who have gone quiet, and a daily summary for the team.
import { brand, sendMail, sendLetter, firstName, type Env } from "./mail";
import { listDocs, putDoc, type Doc } from "./store";
import { slugOf } from "./shop";
import { ensureSchema } from "./schema";

const HOUR = 3600e3, DAY = 24 * HOUR;
const site = (env: Env) => String(env.SITE_ORIGIN || "").replace(/\/+$/, "") || "https://thepeerscertification.com";
const at = (v: unknown) => Date.parse(String(v || "")) || 0;
const money = (pence: number, cur: string) => `${(pence / 100).toFixed(2)} ${String(cur || "").toUpperCase()}`;

/** One email, once, to someone who started enrolling between an hour and three days ago and has not paid. */
export async function nudgeUnpaid(env: Env, now = Date.now()) {
  const orders = await listDocs(env, "orders");
  const key = (o: Doc) => `${String(o.e).toLowerCase()}|${o.course}`;
  const settled = new Set(orders.filter((r) => r.data.status === "paid" || r.data.nudged).map((r) => key(r.data)));
  let sent = 0;
  for (const { id, data: o } of orders) {
    const age = now - at(o.at);
    if (o.status !== "pending" || o.nudged || age < HOUR || age > 3 * DAY) continue;
    await putDoc(env, "orders", id, { ...o, nudged: new Date(now).toISOString() });
    if (settled.has(key(o))) continue; // they paid on another try, or have had the reminder already
    settled.add(key(o));
    await sendLetter(env, o.e, `Your place on ${o.title} is still open`, {
      title: "Your place is still open.",
      preheader: "Finishing your enrolment takes about a minute.",
      hello: `Hi ${firstName(o.n)},`,
      paras: [`You started enrolling on **${o.title}** but didn't finish. Your place is still here, and it only takes a minute.`],
      button: { label: "Finish enrolling", url: `${site(env)}/${slugOf(o.title)}` },
      after: ["Have a question before you decide? Just reply to this email and we'll help.", "This is the only reminder we'll send about this enrolment."],
      small: `You're receiving this because you started enrolling at ${brand(env)}.`,
    });
    sent++;
  }
  return sent;
}

/** A nudge for learners who have not studied for a week: at most one every 14 days, three in a row, and none if they turned reminders off. */
export async function studyReminders(env: Env, now = Date.now()) {
  const accts = await listDocs(env, "lacct");
  const courses = new Map((await listDocs(env, "courses")).map((r) => [r.id, r.data]));
  const certified = new Set((await listDocs(env, "certs")).filter((r) => !r.data.revoked).map((r) => `${r.data.k}|${r.data.course}`));
  const { results } = await env.DB.prepare("SELECT id,data,upd FROM docs WHERE coll='lsub'").all<{ id: string; data: string; upd: number }>();
  const progress = new Map(results.map((r) => [r.id, { w: (JSON.parse(r.data).w || {}) as Record<string, unknown>, upd: Number(r.upd) || 0 }]));
  let sent = 0;
  for (const { id, data: a } of accts) {
    if (a.gone || a.lock || a.rem === false || !Array.isArray(a.c)) continue;
    const p = progress.get(id) || { w: {}, upd: 0 };
    const lastActive = Math.max(p.upd, at(a.at));
    const count = p.upd > (a.nu || 0) ? 0 : a.nc || 0; // studying again resets the run of reminders
    if (now - lastActive < 7 * DAY || now - (a.nu || 0) < 14 * DAY || count >= 3) continue;
    let text = "", lines: string[] = [], btn = { label: "", url: "" };
    for (const cid of a.c) {
      const c = courses.get(cid);
      if (!c || certified.has(`${id}|${cid}`)) continue;
      const lessons: { mi: number; title: string; done: boolean }[] = [];
      (Array.isArray(c.modules) ? c.modules : []).forEach((m: Doc, mi: number) => (Array.isArray(m?.lessons) ? m.lessons : []).forEach((l: Doc, li: number) => lessons.push({ mi, title: String(l?.title || m?.title || ""), done: !!p.w[`${cid}:${mi}:${li}`] })));
      if (!lessons.length) continue;
      const done = lessons.filter((l) => l.done).length, next = lessons.find((l) => !l.done);
      text = c.title;
      if (next) {
        lines = [done ? `You're **${done} of ${lessons.length}** modules into **${c.title}**. Nice work.` : `**${c.title}** is waiting for you.`, `Next up: **Module ${next.mi + 1}, ${next.title}**.`, "Even twenty minutes keeps the momentum going."];
        btn = { label: "Continue my course", url: `${site(env)}/learn/course?c=${encodeURIComponent(cid)}` };
      } else {
        lines = [`You've finished every module of **${c.title}**.`, "The final exam is open, and it's all that stands between you and your certificate."];
        btn = { label: "Take the final exam", url: `${site(env)}/learn/exam?c=${encodeURIComponent(cid)}` };
      }
      break;
    }
    if (!text) continue;
    await putDoc(env, "lacct", id, { ...a, nu: now, nc: count + 1 });
    await sendLetter(env, a.e, "Your next module is ready", {
      title: `Ready for the next step, ${firstName(a.n)}?`,
      preheader: "Pick up right where you left off.",
      paras: lines, button: btn, unsub: true,
      small: "You can turn these reminders off any time in your account settings.",
    });
    sent++;
  }
  return sent;
}

/** What happened in the last 24 hours, emailed to the team. Nothing is sent on a quiet day. */
export async function dailySummary(env: Env, now = Date.now()) {
  const to = env.NOTIFY_TO || env.SMTP_USER || "";
  const since = now - DAY, fresh = (v: unknown) => at(v) > since && at(v) <= now;
  const orders = (await listDocs(env, "orders")).map((r) => r.data);
  const paid = orders.filter((o) => o.status === "paid" && fresh(o.paidAt));
  const unpaid = orders.filter((o) => o.status === "pending" && fresh(o.at));
  const passes = (await listDocs(env, "certs")).map((r) => r.data).filter((c) => fresh(c.at));
  const enquiries = (await listDocs(env, "leads/contact/items")).map((r) => r.data).filter((l) => fresh(l.at));
  const signups = (await listDocs(env, "leads/newsletter/items")).filter((r) => fresh(r.data.at)).length;
  if (!to || !(paid.length + unpaid.length + passes.length + enquiries.length + signups)) return false;
  const takings: Record<string, number> = {};
  for (const o of paid) takings[o.cur] = (takings[o.cur] || 0) + (Number(o.amount) || 0);
  const lines = [
    `Enrolments paid: ${paid.length}${paid.length ? ` (${Object.entries(takings).map(([c, v]) => money(v, c)).join(" + ")})` : ""}`,
    ...paid.map((o) => `  ${o.n} <${o.e}>, ${o.title}, ${money(o.amount, o.cur)}`),
    `Enrolments started and not paid: ${unpaid.length}`,
    `Exams passed and certificates issued: ${passes.length}`,
    ...passes.map((c) => `  ${c.n}, ${c.title}, ${c.pct}%, ${c.no}`),
    `Enquiries: ${enquiries.length}`,
    ...enquiries.map((l) => `  ${l.subject || "Enquiry"}`),
    `Newsletter sign-ups: ${signups}`,
  ];
  await sendLetter(env, to, `${brand(env)}: the last 24 hours`, { title: "The last 24 hours", signoff: false, paras: lines.map((x) => x.trim()), button: { label: "Open admin", url: `${site(env)}/admin` } });
  return true;
}

export async function runScheduled(env: Env, when = Date.now()) {
  await ensureSchema(env);
  await nudgeUnpaid(env, when);
  if (new Date(when).getUTCHours() === 7) { await studyReminders(env, when); await dailySummary(env, when); }
}
