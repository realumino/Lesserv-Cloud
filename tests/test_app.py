"""Tests for the app object under the local runtime.

Why TestClient matters: it boots the same `app` workerd runs, with the
SQLite backend attached by the lifespan, and asserts the routes both
runtimes must serve. Route-group and admin-surface tests live in their own
files; this one pins the wiring only.
"""

import unittest

from fastapi.testclient import TestClient

import local
from tests.support import cleanup_db, make_test_app, open_fresh_db_sync


class TestHealth(unittest.TestCase):
    """The route both runtimes must serve identically."""

    def test_health_is_ok(self):
        with TestClient(local.app) as client:
            response = client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


class TestStartup(unittest.TestCase):
    """The lifespan opens SQLite and applies the real schema migrations.

    Why this exercises data/panel.db: it is the exact startup path a local
    run takes; asserting the schema exists here proves migrations and the
    lifespan wiring work together end to end. The dev database is
    disposable (gitignored); tests must never require it to pre-exist.
    """

    def test_lifespan_attaches_conn_with_schema(self):
        import asyncio

        import local

        async def scenario():
            async with local.lifespan(local.app):
                rows = await local.app.state.conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
                return {row["name"] for row in rows}

        names = asyncio.run(scenario())
        for table in ("nodes", "users", "user_node_access", "reality_keys"):
            self.assertIn(table, names)


class TestAdminSmoke(unittest.TestCase):
    """One request through guard, routing, dependency, db, and schema.

    Why a smoke test here: it proves the admin surface works end to end
    on a fresh app — path allowed by the guard, conn dependency resolving
    from app.state, migrations having created the table.
    """

    def test_admin_nodes_returns_empty_list(self):
        conn, path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, conn, path)

        with TestClient(make_test_app(conn)) as client:
            response = client.get("/api/admin/nodes")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])


if __name__ == "__main__":
    unittest.main()
