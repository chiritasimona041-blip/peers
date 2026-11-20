// Local preview only. Loads the real catalogue from tools/catalogue.json plus the real module links (tools/lessons.json), SAMPLE exam questions, admin and learner.
// Usage: npm run dev (in another terminal), then: node tools/seed-sample.mjs [http://localhost:8787]
const base = process.argv[2] || "http://localhost:8787";
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
let cookie = "";
async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.getSetCookie?.() || [];
  for (const c of set) { const kv = c.split(";")[0]; const name = kv.split("=")[0]; cookie = cookie.split("; ").filter((x) => x && !x.startsWith(name + "=")).concat(kv).join("; "); }
  return { status: r.status, json: await r.json().catch(() => null) };
}
const admin = "admin@sample.test", adminPw = "SampleAdmin1";
await call("POST", "/api/setup", { email: admin, name: "Admin", h: await sha(`${admin}|${adminPw}`) }, { "X-Setup-Token": process.env.SETUP_TOKEN || "local-setup-token" });
const login = await call("POST", "/api/login", { e: admin, h: await sha(`${admin}|${adminPw}`) });
if (!login.json?.ok) throw new Error("admin login failed: " + JSON.stringify(login));
import { readFileSync } from "node:fs";
const { courses: list } = JSON.parse(readFileSync(new URL("./catalogue.json", import.meta.url), "utf8"));
const courses = Object.fromEntries(list.map(({ id, ...rest }) => [id, rest]));
// The real module links (tools/lessons.json): one framed lesson per module, on all 20 certifications.
const links = JSON.parse(readFileSync(new URL("./lessons.json", import.meta.url), "utf8"));
for (const [id, c] of Object.entries(courses)) c.modules = c.modules.map((m, i) => ({ title: m.title, lessons: links[id]?.[i] ? [{ title: m.title, url: links[id][i].url }] : [] }));
for (const [id, data] of Object.entries(courses)) await call("POST", "/api/db/doc", { path: "courses/" + id, op: "set", data });
for (const id of ["life", "transformational"])
  await call("POST", "/api/db/doc", { path: "exams/" + id, op: "set", data: { q: [1, 2, 3, 4, 5].map((n) => ({ q: `Sample question ${n}: which answer is marked correct?`, o: ["Not this one", "This one (sample)", "Not this one either"], a: 1 })) } });
const learner = "learner@sample.test", learnerPw = "SampleLearner1";
await call("POST", "/api/db/doc", { path: "lacct/learner_sample_test", op: "set", data: { n: "Sam Sample", e: learner, c: ["life", "transformational"], cr: "sample", h: await sha(`${learner}|${learnerPw}`) } });
console.log(`Loaded ${Object.keys(courses).length} certifications (real module links on all, sample exams on two).\nAdmin:   ${admin} / ${adminPw}\nLearner: ${learner} / ${learnerPw}`);
