import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * WHAT: run every test inside workerd through the Workers vitest plugin.
 *
 * WHY the migrations are read here and applied in tests/setup.ts: D1 in
 * tests is real D1 semantics, and the schema must match production. WHY the
 * assets directory is overridden to tests/stub-assets: the local wrangler
 * config (seeded from the committed wrangler.example.jsonc) points at the
 * gitignored frontend/dist, and tests must never depend on a SPA build.
 * Paths are relative to the repo root, like the wrangler configPath beside
 * this override.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("migrations");
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          // WHY the binding is declared here and not in wrangler.jsonc:
          // the deploy config never fetches assets from the Worker, so
          // it relies on the default (absent) binding. The asset tests
          // need one to reach the assets service; keeping it in the test
          // harness leaves the deployed config untouched. See
          // tests/workerd/admin_assets.test.ts.
          assets: { directory: "tests/stub-assets", binding: "ASSETS" },
        },
      };
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
