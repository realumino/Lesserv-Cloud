/**
 * Health check route: the cheapest possible proof that the app is alive.
 *
 * WHY this is its own router: `/api/health` is one of the four permanent
 * route groups in AGENTS.md, so it exists in both runtimes from the first
 * commit and is the only route that never depends on a database.
 */

import { Hono } from "hono";

export const health = new Hono();

/**
 * WHAT: answer a constant `{"status": "ok"}` body.
 * WHY: if this responds at all, the app is up; there is nothing to check.
 */
health.get("/api/health", (c) => c.json({ status: "ok" }));
