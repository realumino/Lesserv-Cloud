/**
 * Shared test helpers for the workerd tier.
 *
 * WHY this exists: Python's tests/workerd/harness.py booted a real server
 * and spoke HTTP to it. The vitest plugin runs tests and the Worker in the
 * same isolate, so the equivalent is `exports.default.fetch()` — same HTTP
 * surface, no port, no process. Keeping the call in one helper means every
 * ported test reads like the Python client it came from.
 */

import { env, exports } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";

const ORIGIN = "https://plane.test";

/**
 * WHAT: fetch one path from the Worker's default export.
 *
 * WHY the default export and not the Hono app object: the port's spec is
 * the HTTP behavior, so requests must travel the same fetch path workerd
 * serves in production, routing and error handling included.
 */
export function planeFetch(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(ORIGIN + path, init));
}

/**
 * WHAT: return the migrations the vitest config injected as a binding.
 *
 * WHY a cast: TEST_MIGRATIONS exists only in tests (miniflare bindings),
 * so it is deliberately absent from the generated Cloudflare.Env; the
 * vitest config is the single place that defines it.
 */
export function testMigrations(): D1Migration[] {
  return (env as typeof env & { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
}

/**
 * WHAT: return a unique lowercase alphanumeric id for one test's data.
 *
 * WHY random suffixes: the integration tier shares one D1 (the vitest
 * plugin has no per-test storage isolation), so ids must not collide
 * between tests or between runs. Node ids must be 1-32 chars of
 * `[a-z0-9]` — no hyphens — and hex is safe for usernames too.
 */
export function uid(prefix = ""): string {
  return prefix + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}
