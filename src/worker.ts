/**
 * Worker entrypoint: the Hono app itself, served by workerd.
 *
 * WHY the app is a valid module Worker as-is: a Hono instance exposes a
 * `fetch(request, env, ctx)` method, which is exactly workerd's ES module
 * handler contract. The default export is the whole entrypoint; no
 * adapter, no bridge. Unlike the Pyodide era's `asgi.entrypoint`, the
 * top-level scope has no snapshot-safety constraint beyond "no I/O at
 * import time".
 */

import { app } from "./main";

export default app;
