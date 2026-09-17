"""All database access lives behind this module.

Two backends, one interface. Every function in this file speaks the same
tiny protocol — `await conn.execute(sql, params) -> list[dict]` — and the
caller never knows which backend is underneath:

- `SqliteConn`: local dev and tests (uvicorn, TestClient). Wraps the
  synchronous `sqlite3` module in an async facade so call sites are
  identical to the D1 path.
- `D1Conn`: the Worker runtime. Thin wrapper over the D1 binding obtained
  from `request.scope["env"].DB`.

Why async even on SQLite: D1 has no synchronous API, so db functions must
be `async def` in production. Making the local backend satisfy the same
awaitable interface is what lets M4 swap bodies without touching
signatures, routers, or services. The asymmetry is the convention: pure
code (core/, checks) stays synchronous; anything that touches a conn is
`async def`.
"""

import json
import os
import sqlite3


class SqliteConn:
    """Async facade over a synchronous sqlite3 connection.

    Why check_same_thread=False: FastAPI runs sync endpoints in a worker
    thread pool; a connection opened in the lifespan runs there. Single
    low-traffic process, same reasoning as the archived panel.
    """

    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row

    async def execute(self, sql: str, params=()) -> list[dict]:
        """Run one statement and return all rows as plain dicts."""
        cur = self._conn.execute(sql, params)
        rows = [dict(row) for row in cur.fetchall()]
        self._conn.commit()
        return rows

    async def close(self):
        self._conn.close()


class D1Conn:
    """Async facade over a D1 binding (`env.DB`).

    Why a wrapper at all: D1 returns JsProxy objects through the Pyodide
    FFI; converting to plain Python dicts here (`.to_py()`) keeps every
    caller free of FFI details, exactly like `sqlite3.Row` handling above.
    """

    def __init__(self, binding):
        self._db = binding

    async def execute(self, sql: str, params=()) -> list[dict]:
        """Run one bound statement and return all rows as plain dicts.

        Why .run() and not .all(): run() is the D1 call documented for
        both reads and writes with bound parameters; its result carries
        `results` (the rows) and `meta` (changes, duration). M0 finding:
        the Python binding already hands back a real Python list of
        dicts, so no FFI conversion is needed here.
        """
        stmt = self._db.prepare(sql).bind(*params)
        result = await stmt.run()
        rows = result.results
        return list(rows) if rows else []


def get_conn(request):
    """Return the backend-agnostic conn for this request.

    Why the two-branch lookup: locally the conn was attached to app.state
    by local.py's lifespan; on Workers the ASGI bridge puts the bindings
    object on the ASGI scope as `env`, and the D1 binding is `env.DB`.
    Routers call this and pass the result to db functions, so no router
    ever knows which backend is live.
    """
    conn = getattr(getattr(request, "app", None), "state", None)
    conn = getattr(conn, "conn", None)
    if conn is not None:
        return conn
    env = request.scope.get("env")
    if env is not None and hasattr(env, "DB"):
        return D1Conn(env.DB)
    raise RuntimeError("no database handle: run via local.py or worker.py")


def row_to_dict_with_json(row: dict, json_cols: list[str]) -> dict:
    """Decode JSON-text columns of one row into real structures.

    Why this lives here: SQLite (and D1) have no list/dict column types,
    so lists are stored as JSON text; this is the single spot that turns
    them back into structures. Kept in M0 because the archived panel's
    db.py had the same job and M1 will reuse the shape.
    """
    out = dict(row)
    for col in json_cols:
        out[col] = json.loads(out[col])
    return out
