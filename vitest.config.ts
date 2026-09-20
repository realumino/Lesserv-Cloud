import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * WHAT: run every test inside workerd through the Workers vitest plugin.
 *
 * WHY the migrations are read here and applied in tests/setup.ts: D1 in
 * tests is real D1 semantics, and the schema must match production. WHY the
 * assets directory is overridden to tests/stub-assets: the committed
 * wrangler config points at the gitignored frontend/dist, and tests must
 * never depend on a SPA build. Paths are relative to the repo root, like
 * the wrangler configPath above them.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("migrations");
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          assets: { directory: "tests/stub-assets" },
        },
      };
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
