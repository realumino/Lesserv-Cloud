/**
 * WHAT: create wrangler.jsonc from wrangler.example.jsonc when it is
 * missing.
 *
 * WHY: wrangler.jsonc is the operator's local config — it carries the real
 * custom-domain hostname and D1 name/id, which never get committed — so a
 * fresh clone has only the committed template, and every entrypoint that
 * reads the wrangler config (dev, test, build, types) would fail before
 * doing any work. The template's placeholders are enough for local
 * development and the whole test suite; the operator edits the copy with
 * real values before deploying. Mirrors scripts/stub_frontend_dist.mjs,
 * which does the same for the other gitignored boot input, frontend/dist.
 *
 * Wired as the `predev`, `prebuild`, `predeploy`, `pretest`,
 * `pretest:watch`, and `pretypes` scripts so every entrypoint that needs
 * the config creates it first.
 */

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCAL = join(REPO_ROOT, "wrangler.jsonc");
const EXAMPLE = join(REPO_ROOT, "wrangler.example.jsonc");

if (!existsSync(LOCAL)) {
  copyFileSync(EXAMPLE, LOCAL);
  console.log(
    "wrangler.jsonc created from wrangler.example.jsonc — placeholder " +
      "deploy values; edit it with your own before deploying.",
  );
}
