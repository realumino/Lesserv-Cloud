/*
 * The admin SPA is mounted at /admin, not at the site root.
 *
 * WHY base '/admin/': every built URL (assets, deep links) carries the
 * mount prefix, which is what the M4 done-when calls "a matching Vite
 * base" — wrangler.jsonc serves the mirrored directory layout
 * (dist/admin/** at /admin/**) with not_found_handling set to
 * single-page-application.
 *
 * WHY the root-index fallback plugin: Workers' SPA fallback always serves
 * /index.html from the assets root, but outDir is dist/admin so the deep
 * links (e.g. /admin/nodes/tokyo01) would otherwise 404. The plugin
 * copies the built admin index to the assets root so the fallback serves
 * it, and clears any stale copy at build start.
 *
 * WHY the dev proxy targets :8787: the app runs only under workerd
 * (`npm run dev`, wrangler's default port), and the archived single-node
 * panel's uvicorn port 8000 no longer exists.
 */
import { copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

function spaFallback(): Plugin {
  return {
    name: "spa-fallback-root-index",
    buildStart() {
      rmSync(resolve(here, "dist/index.html"), { force: true });
    },
    closeBundle() {
      copyFileSync(
        resolve(here, "dist/admin/index.html"),
        resolve(here, "dist/index.html"),
      );
    },
  };
}

export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss(), spaFallback()],
  build: {
    outDir: "dist/admin",
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/sub": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
