"""Tests for the node service: creation facts, config save, sync triggers."""

import unittest
from unittest import mock

from models import NodeCreate, NodeUpdate
from services import node_service
from tests.support import cleanup_db, open_fresh_db_sync


class TestNodeService(unittest.IsolatedAsyncioTestCase):
    """The thin rules around the node resource."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)
        # Patch through the module object the service actually calls, not
        # a string target: string targets re-import and can miss the code
        # under test if module identity ever changes between tests.
        patcher = mock.patch.object(node_service.xray_service, "sync_node")
        self.sync_mock = patcher.start()
        self.addCleanup(patcher.stop)

    async def test_create_stamps_created_at_and_has_no_config(self):
        node = await node_service.create_node(
            self.conn, NodeCreate(id="tokyo01", label="Tokyo 01", address="a.example.com")
        )

        self.assertEqual(node["id"], "tokyo01")
        self.assertEqual(node["address"], "a.example.com")
        self.assertFalse(node["has_config"])
        self.assertGreater(node["created_at"], 0)

    async def test_update_merges_partial_fields(self):
        await node_service.create_node(
            self.conn, NodeCreate(id="tokyo01", label="old", address="a")
        )

        node = await node_service.update_node(
            self.conn, "tokyo01", NodeUpdate(label="new")
        )

        self.assertEqual(node["label"], "new")
        self.assertEqual(node["address"], "a")
        self.sync_mock.assert_not_called()

    async def test_update_missing_node_returns_none(self):
        self.assertIsNone(
            await node_service.update_node(self.conn, "ghost", NodeUpdate(label="x"))
        )

    async def test_save_config_stores_blob_and_syncs(self):
        await node_service.create_node(
            self.conn, NodeCreate(id="tokyo01", label="n")
        )
        payload = {"inbounds": [], "outbounds": []}

        self.assertTrue(await node_service.save_config(self.conn, "tokyo01", payload))

        node = await node_service.get_node_out(self.conn, "tokyo01")
        self.assertTrue(node["has_config"])
        self.sync_mock.assert_called_once_with(self.conn, "tokyo01")

    async def test_save_config_missing_node_returns_false_and_never_syncs(self):
        self.assertFalse(await node_service.save_config(self.conn, "ghost", {}))
        self.sync_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
