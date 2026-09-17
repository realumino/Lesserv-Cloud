"""Tests for the SqliteConn async facade.

Why this file exists: the D1 backend is only reachable from inside
workerd, but the interface both backends share can be exercised anywhere.
These tests pin the semantics `db.py`'s callers rely on — awaited
execute returning plain dicts — so M4's D1Conn must satisfy exactly them.
"""

import os
import tempfile
import unittest

from db import SqliteConn


class TestSqliteConn(unittest.TestCase):
    """The local backend's half of the conn interface."""

    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.conn = SqliteConn(self.path)

    def tearDown(self):
        self.conn._conn.close()
        os.unlink(self.path)

    def test_execute_round_trips_values_and_types(self):
        import asyncio

        async def scenario():
            await self.conn.execute(
                "CREATE TABLE spike_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
            )
            await self.conn.execute(
                "INSERT INTO spike_kv (k, v) VALUES (?, ?)", ("k", "v")
            )
            return await self.conn.execute("SELECT v FROM spike_kv WHERE k = ?", ("k",))

        rows = asyncio.run(scenario())
        self.assertEqual(rows, [{"v": "v"}])

    def test_execute_commits_writes(self):
        import asyncio

        async def scenario():
            await self.conn.execute(
                "CREATE TABLE spike_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
            )
            await self.conn.execute(
                "INSERT INTO spike_kv (k, v) VALUES (?, ?)", ("k", "v")
            )
            # A second connection sees committed state, or it does not —
            # this is what makes the facade honest about the commit inside
            # execute() rather than deferring it to close().
            check = SqliteConn(self.path)
            rows = await check.execute("SELECT v FROM spike_kv")
            await check.close()
            return rows

        self.assertEqual(len(asyncio.run(scenario())), 1)


if __name__ == "__main__":
    unittest.main()
