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
from pathlib import Path

from fastapi import FastAPI

from db import SqliteConn
from main import create_app
from migrations import apply_migrations

DB_PATH = "data/panel.db"
# Resolved from this file, not the cwd, so tests and tools that launch
# from any directory still build the same schema.
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the local SQLite database and apply the schema migrations.

    Why a SqliteConn and not a raw connection: every db.py function awaits
    `conn.execute(...)`, so the local backend must satisfy the same async
    interface the D1 backend has. That symmetry is the M0 design finding
    M4 will depend on. The schema comes from migrations/*.sql (via
    migrations.py), the same files wrangler feeds to D1 — one source of
    truth, no drift.
    """
    conn = SqliteConn(DB_PATH)
    await apply_migrations(conn, MIGRATIONS_DIR)
    app.state.conn = conn
    yield
    await conn.close()


app = create_app()
app.router.lifespan_context = lifespan


def main():
    """Run under uvicorn with `src/` on sys.path, matching workerd's import root.

    Why uvicorn is imported here and not at module scope: uvicorn drags in
    multiprocessing, whose import draws from the PRNG. Importing it only
    when actually serving keeps `import local` (tests, the deploy-snapshot
    check) free of any entropy draw, which is what the platform requires
    of every module that ships.
    """
    import uvicorn

    uvicorn.run("local:app", host="127.0.0.1", port=8000, reload=True)


if __name__ == "__main__":
    main()
