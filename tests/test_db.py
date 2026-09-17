"""Tests for the conn interface and the db layer's SQL.

Why this file exists: the D1 backend is only reachable from inside
workerd, but the interface both backends share can be exercised anywhere.
These tests pin the semantics db.py's callers rely on — awaited execute
returning plain dicts — plus round-trips for every table's SQL, so M4's
D1Conn must satisfy exactly them.
"""

import os
import tempfile
import unittest

import db
from db import SqliteConn
from tests.support import cleanup_db, open_fresh_db_sync


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
                "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
            )
            await self.conn.execute(
                "INSERT INTO kv (k, v) VALUES (?, ?)", ("k", "v")
            )
            return await self.conn.execute("SELECT v FROM kv WHERE k = ?", ("k",))

        rows = asyncio.run(scenario())
        self.assertEqual(rows, [{"v": "v"}])

    def test_execute_commits_writes(self):
        import asyncio

        async def scenario():
            await self.conn.execute(
                "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
            )
            await self.conn.execute(
                "INSERT INTO kv (k, v) VALUES (?, ?)", ("k", "v")
            )
            # A second connection sees committed state, or it does not —
            # this is what makes the facade honest about the commit inside
            # execute() rather than deferring it to close().
            check = SqliteConn(self.path)
            rows = await check.execute("SELECT v FROM kv")
            await check.close()
            return rows

        self.assertEqual(len(asyncio.run(scenario())), 1)


class TestDataLayer(unittest.IsolatedAsyncioTestCase):
    """Round-trips through the node/user/access/key SQL, on the real schema.

    Why a fresh temp database per test: tests must never touch real data
    and cannot interfere with each other; the schema comes from the
    migrations, never a copy.
    """

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

    async def test_node_crud_roundtrip(self):
        await db.create_node(self.conn, {
            "id": "tokyo01", "label": "Tokyo 01",
            "address": "funky.example.com", "created_at": 1,
        })

        node = await db.get_node(self.conn, "tokyo01")

        self.assertEqual(node["label"], "Tokyo 01")
        self.assertIsNone(node["config_json"])
        self.assertEqual(
            [n["id"] for n in await db.list_nodes(self.conn)], ["tokyo01"]
        )

    async def test_get_missing_node_returns_none(self):
        self.assertIsNone(await db.get_node(self.conn, "ghost"))

    async def test_node_config_stores_and_clears_opaque_blob(self):
        await db.create_node(self.conn, {
            "id": "tokyo01", "label": "n", "address": "", "created_at": 1,
        })
        config = {"inbounds": [{"tag": "reality"}]}

        await db.set_node_config(self.conn, "tokyo01", config)
        node = await db.get_node(self.conn, "tokyo01")
        self.assertEqual(node["config_json"], config)

        await db.set_node_config(self.conn, "tokyo01", None)
        node = await db.get_node(self.conn, "tokyo01")
        self.assertIsNone(node["config_json"])

    async def test_access_row_roundtrips_json_columns(self):
        await db.upsert_access(
            self.conn, "alice", "tokyo01",
            ["reality"], ["niigata"], {"niigata": "u1"},
        )

        row = await db.get_access(self.conn, "alice", "tokyo01")

        self.assertEqual(row["allowed_inbounds"], ["reality"])
        self.assertEqual(row["allowed_outbounds"], ["niigata"])
        self.assertEqual(row["uuids"], {"niigata": "u1"})

    async def test_upsert_access_replaces_the_whole_row(self):
        await db.upsert_access(
            self.conn, "alice", "tokyo01",
            ["reality"], ["niigata"], {"niigata": "u1"},
        )
        await db.upsert_access(
            self.conn, "alice", "tokyo01", [], ["other"], {"other": "u2"},
        )

        row = await db.get_access(self.conn, "alice", "tokyo01")

        self.assertEqual(row["allowed_inbounds"], [])
        self.assertEqual(row["uuids"], {"other": "u2"})

    async def test_list_access_for_node_is_username_ordered(self):
        for username in ("bob", "alice"):
            await db.create_user(self.conn, {
                "username": username, "status": "active",
                "expire": None, "note": None, "created_at": 1,
            })
            await db.upsert_access(
                self.conn, username, "tokyo01", [], [], {},
            )

        rows = await db.list_access_for_node(self.conn, "tokyo01")

        self.assertEqual([r["username"] for r in rows], ["alice", "bob"])

    async def test_delete_user_removes_access_rows_too(self):
        await db.create_user(self.conn, {
            "username": "alice", "status": "active",
            "expire": None, "note": None, "created_at": 1,
        })
        await db.upsert_access(
            self.conn, "alice", "tokyo01", [], [], {},
        )

        await db.delete_user(self.conn, "alice")

        self.assertIsNone(await db.get_user(self.conn, "alice"))
        self.assertIsNone(await db.get_access(self.conn, "alice", "tokyo01"))

    async def test_reality_keys_are_scoped_per_node(self):
        await db.upsert_reality_key(self.conn, "tokyo01", "reality", "k-tokyo", 1)
        await db.upsert_reality_key(self.conn, "toyama01", "reality", "k-toyama", 2)

        tokyo = await db.list_reality_keys(self.conn, "tokyo01")
        toyama = await db.list_reality_keys(self.conn, "toyama01")

        self.assertEqual(tokyo["reality"]["private_key"], "k-tokyo")
        self.assertEqual(toyama["reality"]["private_key"], "k-toyama")

    async def test_reality_key_upsert_rotates_in_place(self):
        await db.upsert_reality_key(self.conn, "tokyo01", "reality", "old", 1)
        await db.upsert_reality_key(self.conn, "tokyo01", "reality", "new", 2)

        keys = await db.list_reality_keys(self.conn, "tokyo01")

        self.assertEqual(keys["reality"]["private_key"], "new")
        self.assertEqual(keys["reality"]["created_at"], 2)


if __name__ == "__main__":
    unittest.main()
