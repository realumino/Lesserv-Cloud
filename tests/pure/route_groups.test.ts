/**
 * Tests for the fail-closed route-group predicate.
 *
 * Pure function only: `isAllowedPath` decides group membership from a path
 * string, so it runs identically in workerd and in any other JS engine. The
 * middleware behavior it backs lives in tests/workerd/guard.test.ts.
 */

import { describe, expect, it } from "vitest";

import { isAllowedPath } from "../../src/route_groups";

describe("isAllowedPath", () => {
  it("allows exactly the four route groups", () => {
    for (const path of [
      "/api/health",
      "/api/admin/nodes",
      "/api/admin/nodes/tokyo01/config",
      "/api/admin/users/alice/links",
      "/api/node/heartbeat",
      "/sub/sometoken",
    ]) {
      expect(isAllowedPath(path), path).toBe(true);
    }
  });

  it("blocks everything else", () => {
    for (const path of [
      "",
      "/",
      "/docs",
      "/redoc",
      "/openapi.json",
      "/api",
      "/api/admin",
      "/api/node",
      "/sub",
      "/api/users",
      "/api/spike/self-check",
      "/api/adminx",
      "/api/health/extra",
    ]) {
      expect(isAllowedPath(path), path).toBe(false);
    }
  });
});
