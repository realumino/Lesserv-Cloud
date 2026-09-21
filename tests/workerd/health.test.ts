/**
 * Health endpoint over a real plane.
 *
 * WHY only this: the admin smoke moved into admin_nodes.test.ts; the health
 * route is the one both the plane and agents must serve identically.
 */

import { expect, it } from "vitest";

import { planeFetch } from "../helpers";

it("answers the health check", async () => {
  const response = await planeFetch("/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
