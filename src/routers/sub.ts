/**
 * The end-user subscription surface: GET /sub/{token}.
 *
 * WHY a tiny router: this is the whole endpoint. The route guard admits the
 * `/sub/` prefix (one of the four groups since M1), Cloudflare Access
 * bypasses it (since M4), and the body semantics live in
 * `subscription_service` — every token state, known or not, answers 200 so
 * the URL reveals nothing about whether it exists.
 */

import { Hono } from "hono";

import { subscriptionBody } from "../services/subscription_service";

export const subRouter = new Hono<{ Bindings: Env }>();

/**
 * WHAT: serve one user's subscription as base64 text.
 *
 * WHY text/plain and no-store: clients expect raw body bytes, and a
 * capability URL must never sit in a shared cache or a browser back-forward
 * cache. The body is empty (200, not 404) for unknown, disabled, and
 * expired tokens — see `subscriptionBody`.
 */
subRouter.get("/sub/:token", async (c) => {
  const body = await subscriptionBody(c.env, c.req.param("token"));
  return c.body(body, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
});
