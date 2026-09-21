/**
 * The fail-closed route-group guard, over a real plane.
 *
 * WHY HTTP: the middleware must 404 everything outside the four groups on
 * the app that actually serves. The pure `isAllowedPath` predicate lives in
 * tests/pure/route_groups.test.ts.
 */

import { describe, expect, it } from "vitest";

import { planeFetch } from "../helpers";

describe("the route-group guard", () => {
  it("lets a known good route reach its handler", async () => {
    const response = await planeFetch("/api/health");

    expect(response.status).toBe(200);
  });

  it("blocks docs and legacy paths", async () => {
    for (const path of ["/docs", "/openapi.json", "/api/users"]) {
      const response = await planeFetch(path);

      expect(response.status, path).toBe(404);
    }
  });

  it("makes anything outside the groups unreachable", async () => {
    // WHY `/` is not here: static assets serve the SPA at the root before
    // the Worker runs, so it is an assets fact, not a guard fact. The pure
    // predicate still pins `/` as blocked.
    for (const path of [
      "/api",
      "/api/admin",
      "/api/node",
      "/sub",
      "/api/adminx",
      "/api/health/extra",
    ]) {
      const response = await planeFetch(path);

      expect(response.status, path).toBe(404);
    }
  });
});
