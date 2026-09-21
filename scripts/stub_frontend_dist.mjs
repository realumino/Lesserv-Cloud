/**
 * WHAT: write stub SPA indexes when frontend/dist is missing.
 *
 * WHY: the wrangler config points its assets directory at frontend/dist, which is gitignored and only exists after
 * `npm --prefix frontend run build`. wrangler refuses to boot when that
 * directory is absent, so a fresh clone could not run `npm run dev` or
 * `npm run build` at all. The stubs satisfy the config without shipping
 * built assets; a real build overwrites them, and no test asserts on SPA
 * bytes. This mirrors what the Python test harness did at runtime.
 *
 * Wired as the `predev`, `prebuild`, and `predeploy` scripts so every
 * entrypoint that needs the directory creates it first.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB = "<!doctype html><title>plane stub</title>\n";

for (const relative of ["index.html", join("admin", "index.html")]) {
  const path = join(REPO_ROOT, "frontend", "dist", relative);
  if (existsSync(path)) {
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, STUB);
}
