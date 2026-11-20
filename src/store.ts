import type { Env } from "./mail";

export type Doc = Record<string, any>;

export async function getDoc(env: Env, coll: string, id: string): Promise<Doc | null> {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE coll=? AND id=?").bind(coll, id).first<{ data: string }>();
  return r ? JSON.parse(r.data) : null;
}
export async function putDoc(env: Env, coll: string, id: string, data: Doc) {
  await env.DB.prepare(
    "INSERT INTO docs (coll,id,data,upd) VALUES (?,?,?,?) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, upd=excluded.upd",
  ).bind(coll, id, JSON.stringify(data), Date.now()).run();
}
export async function delDoc(env: Env, coll: string, id: string) {
  await env.DB.prepare("DELETE FROM docs WHERE coll=? AND id=?").bind(coll, id).run();
}
export async function listDocs(env: Env, coll: string, where?: { field: string; value: string | number }) {
  const field = where && /^[a-zA-Z0-9_]{1,20}$/.test(where.field) ? where.field : null;
  const sql = field
    ? `SELECT id,data FROM docs WHERE coll=? AND json_extract(data,'$.${field}')=? ORDER BY upd DESC LIMIT 2000`
    : "SELECT id,data FROM docs WHERE coll=? ORDER BY upd DESC LIMIT 2000";
  const st = field ? env.DB.prepare(sql).bind(coll, where!.value) : env.DB.prepare(sql).bind(coll);
  const { results } = await st.all<{ id: string; data: string }>();
  return results.map((r) => ({ id: r.id, data: JSON.parse(r.data) as Doc }));
}
