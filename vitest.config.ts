import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, SETUP_TOKEN: "test-setup-token", NOTIFY_TO: "info@coaching.test", STRIPE_WEBHOOK_SECRET: "whsec_test", OFFER_PCT: "" } },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
