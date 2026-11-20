// First run on the live site: creates the first admin account, then loads the 20 certifications
// (tools/catalogue.json) with their module links (tools/lessons.json). No sample learners, no sample exams.
// Safe to run again: the admin step is skipped if an admin exists, and courses are overwritten with the same data.
//
// Usage (macOS / Linux):
//   SETUP_TOKEN=... ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node tools/go-live.mjs https://your-worker.workers.dev
import { readFileSync } from "node:fs";

const base = (process.argv[2] || "").replace(/\/+$/, "");
const { SETUP_TOKEN = "", ADMIN_EMAIL = "", ADMIN_PASSWORD = "", ADMIN_NAME = "Admin" } = process.env;
const email = ADMIN_EMAIL.trim().toLowerCase();
const stop = (m) => { console.error("Stopped: " + m); process.exit(1); };
if (!/^https:\/\//.test(base)) stop("give the site address, e.g. https://thepeerscertification.yourname.workers.dev");
if (!SETUP_TOKEN) stop("SETUP_TOKEN is missing (the same value you saved with: npx wrangler secret put SETUP_TOKEN)");
if (!/^\S+@\S+\.\S+$/.test(email)) stop("ADMIN_EMAIL is missing or not an email address");
if (ADMIN_PASSWORD.length < 8 || !/[a-z]/.test(ADMIN_PASSWORD) || !/[A-Z]/.test(ADMIN_PASSWORD) || !/[0-9]/.test(ADMIN_PASSWORD))
  stop("ADMIN_PASSWORD needs 8+ characters with an upper case letter, a lower case letter and a number");

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
let cookie = "";
async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(";")[0], name = kv.split("=")[0]; cookie = cookie.split("; ").filter((x) => x && !x.startsWith(name + "=")).concat(kv).join("; "); }
  return { status: r.status, json: await r.json().catch(() => null) };
}

const h = await sha(`${email}|${ADMIN_PASSWORD}`); // the same hash the sign-in page makes in the browser
const setup = await call("POST", "/api/setup", { email, name: ADMIN_NAME, h }, { "X-Setup-Token": SETUP_TOKEN });
if (setup.status === 200) console.log("Admin created: " + email);
else if (setup.status === 409) console.log("An admin already exists, skipping that step.");
else stop(`could not create the admin (${setup.status} ${setup.json?.error || ""}). Check SETUP_TOKEN matches the secret.`);

const login = await call("POST", "/api/login", { e: email, h });
if (!login.json?.ok) stop("could not sign in as " + email + ". If an admin already existed, use its email and password.");

const { courses } = JSON.parse(readFileSync(new URL("./catalogue.json", import.meta.url), "utf8"));
const links = JSON.parse(readFileSync(new URL("./lessons.json", import.meta.url), "utf8"));
let n = 0;
for (const { id, ...c } of courses) {
  c.modules = c.modules.map((m, i) => ({ title: m.title, lessons: links[id]?.[i] ? [{ title: m.title, url: links[id][i].url }] : [] }));
  const r = await call("POST", "/api/db/doc", { path: "courses/" + id, op: "set", data: c });
  if (r.status !== 200) stop(`course ${id} was not saved (${r.status} ${r.json?.error || ""})`);
  n++;
}
const cat = await call("GET", "/api/catalogue");
console.log(`Loaded ${n} certifications. The catalogue now shows ${cat.json?.courses?.length ?? "?"}.\nSign in at ${base}/login with ${email}.`);
