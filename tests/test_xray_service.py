"""Tests for the local runtime stopgap: runtime files, status, sync.

Adapted from the archived panel's test_system.py: the same file semantics
and the same sync wiring, now per node. Rendering itself is covered by
tests/test_render_service.py; this file pins what wraps it.
"""

import os
import tempfile
import unittest
from unittest import mock

import db
import settings
from services import xray_service
from tests.support import cleanup_db, open_fresh_db_sync


def _config():
    """A minimal authored config for the sync tests."""
    return {
        "inbounds": [
            {
                "tag": "reality",
                "protocol": "vless",
                "settings": {"clients": []},
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {"privateKey": "operator-key"},
                },
            },
        ],
        "outbounds": [{"tag": "niigata", "protocol": "freedom"}],
    }


class TestRuntimeFile(unittest.TestCase):
    """Atomically written, tolerantly read, per node."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        patcher = mock.patch.object(settings, "RUNTIME_DIR", self.tmpdir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_write_then_load_roundtrip(self):
        content = {"inbounds": [], "outbounds": []}

        xray_service.write_runtime_config("tokyo01", content)

        self.assertEqual(xray_service.load_runtime_config("tokyo01"), content)

    def test_load_none_when_missing(self):
        self.assertIsNone(xray_service.load_runtime_config("ghost"))

    def test_load_none_when_malformed(self):
        path = xray_service.runtime_path("tokyo01")
        os.makedirs(self.tmpdir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{not json")

        self.assertIsNone(xray_service.load_runtime_config("tokyo01"))

    def test_runtime_file_is_scoped_per_node(self):
        xray_service.write_runtime_config("tokyo01", {"a": 1})

        self.assertIsNone(xray_service.load_runtime_config("toyama01"))

    def test_runtime_mtime_none_when_missing(self):
        self.assertIsNone(xray_service.runtime_mtime("ghost"))

    def test_runtime_mtime_is_a_timestamp_after_write(self):
        xray_service.write_runtime_config("tokyo01", {"a": 1})

        self.assertIsInstance(xray_service.runtime_mtime("tokyo01"), int)


class TestStatus(unittest.TestCase):
    """Expose Xray subprocess health without side effects."""

    def tearDown(self):
        xray_service._process = None

    def test_status_when_no_process(self):
        xray_service._process = None

        self.assertEqual(
            xray_service.status(), {"running": False, "pid": None}
        )

    def test_status_when_process_is_running(self):
        proc = mock.MagicMock()
        proc.poll.return_value = None
        proc.pid = 42
        xray_service._process = proc

        self.assertEqual(xray_service.status(), {"running": True, "pid": 42})

    def test_status_when_process_exited(self):
        proc = mock.MagicMock()
        proc.poll.return_value = 1
        xray_service._process = proc

        self.assertEqual(
            xray_service.status(), {"running": False, "pid": None}
        )


class TestSync(unittest.IsolatedAsyncioTestCase):
    """The full sync wiring: render, write, restart — nothing raises."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        patchers = [
            mock.patch.object(settings, "RUNTIME_DIR", self.tmpdir),
            mock.patch.object(xray_service, "restart"),  # no subprocess
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

    async def _seed(self, config=None):
        await db.create_node(self.conn, {
            "id": "tokyo01", "label": "n", "address": "", "created_at": 1,
        })
        if config is not None:
            await db.set_node_config(self.conn, "tokyo01", config)
        await db.create_user(self.conn, {
            "username": "alice", "status": "active",
            "expire": None, "note": None, "created_at": 1,
        })
        await db.upsert_access(
            self.conn, "alice", "tokyo01",
            ["reality"], ["niigata"], {"niigata": "u1"},
        )

    async def test_sync_writes_rendered_runtime_with_clients(self):
        await self._seed(config=_config())

        await xray_service.sync_node(self.conn, "tokyo01")

        runtime = xray_service.load_runtime_config("tokyo01")
        self.assertEqual(runtime["inbounds"][0]["tag"], "reality-tokyo01")
        self.assertEqual(
            runtime["inbounds"][0]["settings"]["clients"],
            [{"id": "u1", "email": "alice@tokyo01-niigata"}],
        )
        self.assertNotEqual(
            runtime["inbounds"][0]["streamSettings"]["realitySettings"]["privateKey"],
            "operator-key",
        )

    async def test_sync_generates_and_stores_the_key(self):
        await self._seed(config=_config())

        await xray_service.sync_node(self.conn, "tokyo01")

        keys = await db.list_reality_keys(self.conn, "tokyo01")
        runtime = xray_service.load_runtime_config("tokyo01")
        self.assertEqual(
            runtime["inbounds"][0]["streamSettings"]["realitySettings"]["privateKey"],
            keys["reality"]["private_key"],
        )

    async def test_sync_without_config_writes_nothing(self):
        await self._seed(config=None)

        await xray_service.sync_node(self.conn, "tokyo01")

        self.assertIsNone(xray_service.load_runtime_config("tokyo01"))
        self.assertEqual(await db.list_reality_keys(self.conn, "tokyo01"), {})

    async def test_sync_of_malformed_config_writes_nothing_and_does_not_raise(self):
        await self._seed(config={"inbounds": "not a list"})

        await xray_service.sync_node(self.conn, "tokyo01")

        self.assertIsNone(xray_service.load_runtime_config("tokyo01"))

    async def test_sync_nodes_covers_each_node(self):
        await self._seed(config=_config())
        await db.create_node(self.conn, {
            "id": "toyama01", "label": "n", "address": "", "created_at": 1,
        })

        await xray_service.sync_nodes(self.conn, ["tokyo01", "toyama01"])

        self.assertIsNotNone(xray_service.load_runtime_config("tokyo01"))
        self.assertIsNone(xray_service.load_runtime_config("toyama01"))


if __name__ == "__main__":
    unittest.main()
