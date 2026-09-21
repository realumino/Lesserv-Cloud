/**
 * The built SPA is served at /admin with a deep-link fallback.
 *
 * Ported from tests/workerd/test_admin_assets.py with its assertions intact.
 * WHY this tier: static assets are matched before the Worker, so only the
 * assets surface can prove the M4/M5 serving arrangement still holds after
 * the M5 rebuild. Two behaviors matter and are easy to break: a browser
 * navigation to a deep link must return the shell (the refreshable-URL
 * claim), and a non-navigation request to an unknown path must still fail
 * closed rather than being handed the shell.
 *
 * Finding (TS5): @cloudflare/vitest-plugin v1.1.13 exposes no
 * `createTestHarness`, and `exports.default.fetch()` never routes static
 * assets (the plugin's worker entry is the Hono app alone). `env.ASSETS`
 * is declared for the test harness in vitest.config.ts and reaches the
 * assets service itself — enough for the shell and navigation-fallback
 * assertions — but not the edge's assets router, so the non-navigation
 * fallthrough to the Worker is pinned on the Worker side below.
 *
 * WHY navigation headers are explicit: at the edge, workerd's
 * single-page-application handling serves the root index only to navigation
 * requests (browsers send `Sec-Fetch-Mode: navigate`) and hands every other
 * miss to the Worker. A bare HTTP client is not a browser navigation, so
 * the requests say which they are rather than assuming it.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { planeFetch } from "../helpers";

const ORIGIN = "https://plane.test";

const NAVIGATION = {
  Accept: "text/html,application/xhtml+xml",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Site": "none",
};

/**
 * WHAT: the test-only assets binding, typed locally.
 *
 * WHY a cast: the deploy wrangler config never fetches assets from the
 * Worker, so `wrangler types` does not emit ASSETS into Env; the vitest
 * config declares the binding for the tests alone, exactly like
 * `TEST_MIGRATIONS` in tests/helpers.ts.
 */
function assets(): Fetcher {
  return (env as typeof env & { ASSETS: Fetcher }).ASSETS;
}

/** WHAT: fetch one path from the assets service, where asset hits land. */
function assetsFetch(
  path: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return assets().fetch(new Request(ORIGIN + path, { headers }));
}

describe("the admin static surface", () => {
  it("serves the shell at the admin root", async () => {
    const response = await assetsFetch("/admin/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect((await response.text()).toLowerCase()).toContain("<!doctype");
  });

  it("serves the shell to a deep-link navigation", async () => {
    // The M5 done-when: /admin/nodes/tokyo01/config is refreshable.
    const response = await assetsFetch(
      "/admin/nodes/tokyo01/config",
      NAVIGATION,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect((await response.text()).toLowerCase()).toContain("<!doctype");
  });

  it("fails closed for an unknown non-navigation path", async () => {
    // The edge serves the shell to navigations only; every other /admin
    // miss falls through to the Worker, whose fail-closed guard answers
    // with a JSON 404 — the assertion below, made through the same fetch
    // path production reaches after that fallthrough. Even a request that
    // claims to be a navigation and deep-links into the SPA never receives
    // the shell from the Worker.
    const response = await planeFetch("/admin/nodes/tokyo01/config", {
      headers: NAVIGATION,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
