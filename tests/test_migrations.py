"""Tests for the local migration runner.

Why this file exists: the schema must come from migrations/*.sql on every
backend. These tests pin the runner's semantics — apply once, record, and
never re-apply — so local dev and a fresh D1 (M4, via wrangler) always
agree on what "the schema" is.
"""

import os
import tempfile
import unittest

from db import SqliteConn
from migrations import apply_migrations


def _fresh_conn():
    """Open a throwaway SQLite conn, mirroring the other db tests."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return SqliteConn(path), path


class TestApplyMigrations(unittest.IsolatedAsyncioTestCase):
    """Apply once, create the tables, and stay a no-op afterwards."""

    def setUp(self):
        self.conn, self.path = _fresh_conn()
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        self.conn._conn.close()
        os.unlink(self.path)

    async def test_applies_init_and_creates_tables(self):
        applied = await apply_migrations(self.conn, "migrations")

        self.assertEqual(applied, ["0001_init.sql", "0002_link_profiles.sql"])
        rows = await self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
        names = {row["name"] for row in rows}
        for table in ("nodes", "users", "user_node_access", "reality_keys", "link_profiles"):
            self.assertIn(table, names)

    async def test_second_run_applies_nothing(self):
        await apply_migrations(self.conn, "migrations")

        applied = await apply_migrations(self.conn, "migrations")

        self.assertEqual(applied, [])


if __name__ == "__main__":
    unittest.main()
