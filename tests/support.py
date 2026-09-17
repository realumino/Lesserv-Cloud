"""Shared helpers for tests that need a throwaway database.

Why this file exists: every data/service test needs a fresh SQLite file
with the real schema applied; building it here keeps each test file's
setup to one call and guarantees the schema is always the migrations',
never a hand-copied DDL. Not named `test_*` so discovery ignores it.
"""

import asyncio
import os
import tempfile

from db import SqliteConn
from main import create_app
from migrations import apply_migrations


def make_db_path() -> str:
    """Return a fresh temp-file path for a test database."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return path


async def open_fresh_db() -> tuple[SqliteConn, str]:
    """Return (conn, path): a temp SQLite conn with all migrations applied."""
    path = make_db_path()
    conn = SqliteConn(path)
    await apply_migrations(conn, _migrations_dir())
    return conn, path


def open_fresh_db_sync() -> tuple[SqliteConn, str]:
    """Sync variant for plain TestCase classes that drive TestClient.

    Why it exists: TestClient runs the app in its own event loop, so the
    test class itself can stay synchronous; only the one-time setup needs
    an event loop.
    """
    return asyncio.run(open_fresh_db())


def cleanup_db(conn, path):
    """Close and unlink a test database (sync, for addCleanup)."""
    conn._conn.close()
    os.unlink(path)


def make_test_app(conn) -> object:
    """Return a fresh app with `conn` attached, ready for TestClient.

    Why not local.app: HTTP tests must run against a throwaway database,
    not the dev database file, and a fresh app per class keeps route
    tables isolated. TestClient is used without a context manager, so no
    lifespan runs and the manually attached conn is the one used.
    """
    app = create_app()
    app.state.conn = conn
    return app


def _migrations_dir() -> str:
    """Resolve the repo's migrations directory from this file's location.

    Why not the cwd: tests may run from any directory; the migrations
    folder sits next to `src/`, two levels up from this file.
    """
    return os.path.join(os.path.dirname(__file__), "..", "migrations")
