import { connect } from "cloudflare:sockets";

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  BRAND_NAME?: string;
  SITE_ORIGIN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  CURRENCY?: string;
  PASS_MARK?: string;
  CERT_PREFIX?: string;
  SETUP_TOKEN?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  NOTIFY_TO?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  OFFER_PCT?: string;
  OFFER_UNTIL?: string;
  GUARANTEE_DAYS?: string;
};

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin);
};
// Brand name shown in emails. Set BRAND_NAME in wrangler.toml to change it.
export const brand = (env: Env) => String(env.BRAND_NAME || "The Peers Certification");
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

// Minimal SMTP client (implicit TLS on port 465, AUTH LOGIN). Credentials come only from Worker Secrets.
export async function smtpSend(env: Env, to: string, subject: string, body: string, probeOnly = false): Promise<{ ok: boolean; err?: string }> {
  const user = String(env.SMTP_USER || "");
  const pass = String(env.SMTP_PASS || "");
  if (!EMAIL.test(user)) return { ok: false, err: "SMTP_USER is missing or is not a full email address" };
  if (!pass) return { ok: false, err: "SMTP_PASS is missing" };
  if (!probeOnly && !EMAIL.test(to)) return { ok: false, err: "bad recipient" };
  const port = Number(env.SMTP_PORT || 465);
  const host = env.SMTP_HOST || "mail.privateemail.com";
  const dom = user.split("@")[1] || "localhost";
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const work = (async () => {
    const socket = connect({ hostname: host, port }, { secureTransport: port === 465 ? "on" : "off", allowHalfOpen: false });
    const w = socket.writable.getWriter();
    const r = socket.readable.getReader();
    let buf = "";
    const read = async (): Promise<string> => {
      for (;;) {
        const m = buf.match(/^(?:\d{3}-[^\r\n]*\r\n)*\d{3} [^\r\n]*\r\n/);
        if (m) { buf = buf.slice(m[0].length); return m[0]; }
        const { value, done } = await r.read();
        if (done) throw new Error("smtp closed");
        buf += dec.decode(value, { stream: true });
      }
    };
    const cmd = async (line: string, ok: number[]) => {
      await w.write(enc.encode(line + "\r\n"));
      const res = await read();
      if (!ok.includes(Number(res.slice(0, 3)))) throw new Error("server said " + res.replace(/\s+/g, " ").trim().slice(0, 160) + (line.length > 40 || /^[A-Za-z0-9+/=]{6,}$/.test(line) ? "" : " (after " + line.slice(0, 20) + ")"));
    };
    try {
      if (Number((await read()).slice(0, 3)) !== 220) throw new Error("smtp greeting");
      await cmd("EHLO " + dom, [250]);
      await cmd("AUTH LOGIN", [334]);
      await cmd(b64(user), [334]);
      await cmd(b64(pass), [235]);
      if (probeOnly) { try { await w.write(enc.encode("QUIT\r\n")); } catch {} return true; }
      await cmd(`MAIL FROM:<${user}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd("DATA", [354]);
      const text = body.replace(/\r?\n/g, "\r\n");
      const payload = (b64(text).match(/.{1,76}/g) || []).join("\r\n");
      const head = [
        `From: ${brand(env)} <${user}>`,
        `To: <${to}>`,
        `Subject: =?UTF-8?B?${b64(subject.replace(/[\r\n]+/g, " "))}?=`,
        `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
        `Message-ID: <${crypto.randomUUID()}@${dom}>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
      ].join("\r\n");
      await cmd(head + "\r\n\r\n" + payload + "\r\n.", [250]);
      try { await w.write(enc.encode("QUIT\r\n")); } catch {}
      return true;
    } finally {
      try { await socket.close(); } catch {}
    }
  })();
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out connecting to " + host + ":" + port)), 15000));
  try { await Promise.race([work, timeout]); return { ok: true }; } catch (e: any) { return { ok: false, err: String(e?.message || e).slice(0, 220) }; }
}

// Sends through the Private Email mailbox when the SMTP secrets exist, else Resend, else only logs.
export async function sendMail(env: Env, to: string, subject: string, body: string) {
  const now = new Date().toISOString();
  let sent = 0;
  if (env.SMTP_USER && env.SMTP_PASS) {
    const r = await smtpSend(env, to, subject, body);
    sent = r.ok ? 1 : 0;
    if (!r.ok) {
      console.log("mail failed:", r.err);
      try { await env.DB.prepare("INSERT INTO docs (coll,id,data,upd) VALUES ('mailerr',?,?,?)").bind(String(Date.now()), JSON.stringify({ to, subject: subject.slice(0, 80), err: r.err }), Date.now()).run(); } catch {}
    }
  } else if (env.RESEND_API_KEY && env.MAIL_FROM) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text: body }),
      });
      sent = r.ok ? 1 : 0;
    } catch {
      sent = 0;
    }
  }
  await env.DB.prepare("INSERT INTO email_log (to_email,subject,body,sent,created_at) VALUES (?,?,?,?,?)")
    .bind(to, subject, body, sent, now)
    .run();
  if (!sent && !(env.SMTP_USER && env.SMTP_PASS) && !(env.RESEND_API_KEY && env.MAIL_FROM)) {
    // Names only, never values: shows whether the mailbox settings reached this deployment, or were typed under another name.
    let names: string[] = [];
    try { names = Object.keys(env as any).filter((k) => k !== "DB" && k !== "ASSETS"); } catch {}
    try { await env.DB.prepare("INSERT INTO docs (coll,id,data,upd) VALUES ('mailerr',?,?,?)").bind(String(Date.now()), JSON.stringify({ to, subject: subject.slice(0, 80), err: "no mailbox settings found", userSet: !!env.SMTP_USER, passSet: !!env.SMTP_PASS, names }), Date.now()).run(); } catch {}
  }
}
