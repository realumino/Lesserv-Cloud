"""Local entrypoint: the same `app` under uvicorn, backed by SQLite.

Why this file exists: locally there is no `env` with bindings, so the
SQLite connection is attached to `app.state` at startup and the request
dependency finds it there. On Workers the equivalent handle comes from
`request.scope["env"].DB` (see db.py). Importing this module is the only
place `sqlite3` is ever imported, so workerd never touches it.

Run from the repo root with:
    uv run uvicorn local:app --app-dir src --reload
"""

from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from db import SqliteConn
from main import create_app

DB_PATH = "data/panel.db"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the local SQLite database for the lifetime of the process.

    Why a SqliteConn and not a raw connection: every db.py function awaits
    `conn.execute(...)`, so the local backend must satisfy the same async
    interface the D1 backend has. That symmetry is the M0 design finding
    M4 will depend on. The spike table is created here because local
    SQLite has no migration runner — D1 gets it from migrations/ instead.
    """
    conn = SqliteConn(DB_PATH)
    await conn.execute("CREATE TABLE IF NOT EXISTS spike_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    app.state.conn = conn
    yield
    await conn.close()


app = create_app()
app.router.lifespan_context = lifespan


def main():
    """Run under uvicorn with `src/` on sys.path, matching workerd's import root."""
    uvicorn.run("local:app", host="127.0.0.1", port=8000, reload=True)


if __name__ == "__main__":
    main()
