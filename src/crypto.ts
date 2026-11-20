const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));

export async function hashPassword(pw: string, saltHex?: string) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
    key,
    256,
  );
  return { hash: hex(bits), salt: hex(salt) };
}

export async function verifyPassword(pw: string, hash: string, salt: string) {
  const r = await hashPassword(pw, salt);
  let diff = r.hash.length ^ hash.length;
  for (let i = 0; i < r.hash.length; i++) diff |= r.hash.charCodeAt(i) ^ (hash.charCodeAt(i) || 0);
  return diff === 0;
}

export async function sha256(s: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export function newToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
