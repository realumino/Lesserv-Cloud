/**
 * The Hono application.
 *
 * WHY a module-level app and not a factory: workerd takes the deploy-time
 * memory snapshot of the top-level scope, so the module must be
 * side-effect free — building the app object is pure, and no request-time
 * binding is touched until a request arrives. Bindings travel on the Hono
 * context (`c.env`), which replaces FastAPI's `routers/deps.py` wrapper.
 */

import { Hono } from "hono";

import { isAllowedPath } from "./route_groups";
import { health } from "./routers/health";

export const app = new Hono<{ Bindings: Env }>();

/**
 * WHAT: reject any path outside the four route groups with a bare 404.
 *
 * WHY middleware and not per-router checks: fail-closed must hold for
 * routes that do not exist yet and for mistakes made later. One check in
 * front of routing cannot be forgotten by a new router, and there is no
 * way to satisfy it partially — the path either sits in a group or the
 * request never reaches one.
 */
app.use("*", async (c, next) => {
  if (!isAllowedPath(new URL(c.req.url).pathname)) {
    return c.json({ detail: "Not found" }, 404);
  }
  await next();
});

/** WHAT: the 404 for an allowed group with no matching route. */
app.notFound((c) => c.json({ detail: "Not found" }, 404));

/**
 * WHAT: turn an unexpected error into the `{detail}` envelope.
 *
 * WHY log here: FastAPI logged the traceback and returned a 500; the
 * Worker keeps the same shape so the SPA's error parsing never sees a
 * bare text body.
 */
app.onError((error, c) => {
  console.error(error);
  return c.json({ detail: "Internal Server Error" }, 500);
});

app.route("/", health);
