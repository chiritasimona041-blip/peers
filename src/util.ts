export const lmKey = (x: unknown) =>
  String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
export const S = (v: unknown, n: number) => String(v ?? "").slice(0, n);
export const isHex64 = (h: unknown): h is string => /^[0-9a-f]{64}$/.test(String(h ?? ""));
export class HttpErr extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
