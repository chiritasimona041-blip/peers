declare module "cloudflare:test" {
  export const env: Env & { TEST_MIGRATIONS: unknown };
  export const SELF: { fetch(i: string, init?: RequestInit): Promise<Response> };
  export function applyD1Migrations(db: D1Database, m: unknown): Promise<void>;
}
