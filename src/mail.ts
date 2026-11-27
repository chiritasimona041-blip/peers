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
export async function smtpSend(env: Env, to: string, subject: string, body: string, probeOnly = false, html = "", unsub = false): Promise<{ ok: boolean; err?: string }> {
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
      const part = (s: string) => (b64(s.replace(/\r?\n/g, "\r\n")).match(/.{1,76}/g) || []).join("\r\n");
      const boundary = "=_tpc_" + crypto.randomUUID().replace(/-/g, "");
      const head = [
        `From: =?UTF-8?B?${b64(brand(env))}?= <${user}>`,
        `Reply-To: <${user}>`,
        `To: <${to}>`,
        `Subject: =?UTF-8?B?${b64(subject.replace(/[\r\n]+/g, " "))}?=`,
        `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
        `Message-ID: <${crypto.randomUUID()}@${dom}>`,
        ...(unsub ? [`List-Unsubscribe: <mailto:${user}?subject=Unsubscribe>`] : []),
        "MIME-Version: 1.0",
        ...(html
          ? [`Content-Type: multipart/alternative; boundary="${boundary}"`]
          : ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"]),
      ].join("\r\n");
      const payload = html
        ? [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", part(body),
           `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", part(html), `--${boundary}--`].join("\r\n")
        : part(body);
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
export async function sendMail(env: Env, to: string, subject: string, body: string, html = "", unsub = false) {
  const now = new Date().toISOString();
  let sent = 0;
  if (env.SMTP_USER && env.SMTP_PASS) {
    const r = await smtpSend(env, to, subject, body, false, html, unsub);
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
        body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text: body, ...(html ? { html } : {}) }),
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

// ---------- branded emails: one layout, a designed version and a plain-text version of every email ----------
export type Letter = {
  title: string;                       // the big headline, e.g. "Welcome, Simona."
  preheader?: string;                  // the grey preview line inboxes show after the subject
  hello?: string;                      // "Hi Simona,"
  paras: string[];                     // short paragraphs; **bold** is allowed
  box?: { label: string; value: string };
  button?: { label: string; url: string };
  bullets?: string[];
  after?: string[];                    // smaller notes under the button
  small?: string;                      // footer line: why they got this email
  signoff?: boolean;                   // "Warm wishes, The Peers Certification team" (default yes)
  unsub?: boolean;                     // marketing-style reminders get a List-Unsubscribe header
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const rich = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong style="color:#1D1916;font-weight:700">$1</strong>');
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1");
export const siteUrl = (env: Env) => (String(env.SITE_ORIGIN || "").replace(/\/+$/, "") || "https://thepeerscertification.com");
export const firstName = (n: unknown) => String(n || "").trim().split(/\s+/)[0] || "there";

export function renderLetter(env: Env, l: Letter): { text: string; html: string } {
  const b = brand(env), site = siteUrl(env), host = site.replace(/^https?:\/\//, ""), from = String(env.SMTP_USER || env.NOTIFY_TO || "");
  const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif", SERIF = "Georgia,'Times New Roman',serif";
  const words = b.split(" "), lastWord = words.pop() || "";
  const signoff = l.signoff === false ? "" : `Warm wishes,\nThe ${b.replace(/^The /, "")} team`;
  // plain text
  const text = [
    l.title, l.hello || "", ...l.paras.map(plain),
    l.box ? `${l.box.label}: ${l.box.value}` : "",
    l.button ? `${l.button.label}:\n${l.button.url}` : "",
    (l.bullets || []).map((x) => `- ${plain(x)}`).join("\n"),
    ...(l.after || []).map(plain),
    signoff, "--", `${b} · ${host}` + (from ? ` · ${from}` : ""), l.small || "",
  ].filter(Boolean).join("\n\n");
  // designed version: tables and inline styles, so it looks the same in Gmail, Outlook and Apple Mail
  const p = (s: string) => `<p style="margin:0 0 16px;font-family:${F};font-size:16px;line-height:1.6;color:#3B342F">${rich(s)}</p>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(l.title)}</title></head>
<body style="margin:0;padding:0;background:#F6F1EA;-webkit-text-size-adjust:100%">
${l.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#F6F1EA">${esc(l.preheader)}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6F1EA"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 6px 18px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="width:34px;height:34px;border-radius:17px;background:#F0A868;text-align:center;vertical-align:middle;font-family:${SERIF};font-style:italic;font-size:19px;color:#1D1916">${esc(b.replace(/^The /, "").charAt(0))}</td>
    <td style="padding-left:10px;font-family:${SERIF};font-size:20px;color:#1D1916">${esc(words.join(" "))} <em style="color:#A8521D">${esc(lastWord)}</em></td>
  </tr></table>
</td></tr>
<tr><td style="background:#FFFFFF;border-radius:22px;padding:40px 36px 32px">
  <h1 style="margin:0 0 22px;font-family:${SERIF};font-weight:normal;font-size:32px;line-height:1.15;color:#1D1916">${esc(l.title)}</h1>
  ${l.hello ? p(l.hello) : ""}
  ${l.paras.map(p).join("\n  ")}
  ${l.box ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px"><tr><td style="background:#F6F1EA;border-radius:14px;padding:18px 22px">
    <div style="font-family:${F};font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#A8521D">${esc(l.box.label)}</div>
    <div style="font-family:${SERIF};font-size:26px;color:#1D1916;padding-top:4px">${esc(l.box.value)}</div></td></tr></table>` : ""}
  ${l.button ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 26px"><tr><td style="background:#1D1916;border-radius:999px">
    <a href="${esc(l.button.url)}" style="display:inline-block;padding:15px 30px;font-family:${F};font-size:16px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px">${esc(l.button.label)} &rarr;</a></td></tr></table>` : ""}
  ${(l.bullets || []).length ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">${(l.bullets || []).map((x) => `<tr><td style="vertical-align:top;padding:0 10px 10px 0;font-family:${F};font-size:16px;color:#A8521D;font-weight:700">&#10003;</td><td style="padding:0 0 10px;font-family:${F};font-size:15px;line-height:1.5;color:#3B342F">${rich(x)}</td></tr>`).join("")}</table>` : ""}
  ${(l.after || []).map((s) => `<p style="margin:0 0 12px;font-family:${F};font-size:14px;line-height:1.6;color:#6A615A">${rich(s)}</p>`).join("\n  ")}
  ${l.button ? `<p style="margin:0 0 12px;font-family:${F};font-size:13px;line-height:1.5;color:#8A8079">Button not working? Copy this link into your browser:<br><a href="${esc(l.button.url)}" style="color:#A8521D;word-break:break-all">${esc(l.button.url)}</a></p>` : ""}
  ${signoff ? `<p style="margin:22px 0 0;font-family:${F};font-size:16px;line-height:1.6;color:#3B342F">${esc(signoff).replace("\n", "<br>")}</p>` : ""}
</td></tr>
<tr><td style="padding:22px 10px 0;text-align:center;font-family:${F};font-size:12px;line-height:1.6;color:#8A8079">
  ${esc(b)} · <a href="${esc(site)}" style="color:#8A8079">${esc(host)}</a>${from ? ` · <a href="mailto:${esc(from)}" style="color:#8A8079">${esc(from)}</a>` : ""}${l.small ? `<br>${esc(l.small)}` : ""}
</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

/** Sends a branded email: a designed version plus a plain-text version. */
export async function sendLetter(env: Env, to: string, subject: string, l: Letter) {
  const { text, html } = renderLetter(env, l);
  return sendMail(env, to, subject, text, html, !!l.unsub);
}
