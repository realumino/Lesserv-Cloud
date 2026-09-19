"""Tests for the node service: creation facts and config save."""

import unittest

from models import NodeCreate, NodeUpdate
from services import node_service
from tests.support import cleanup_db, open_fresh_db_sync


class TestNodeService(unittest.IsolatedAsyncioTestCase):
    """The thin rules around the node resource."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

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

    async def test_update_missing_node_returns_none(self):
        self.assertIsNone(
            await node_service.update_node(self.conn, "ghost", NodeUpdate(label="x"))
        )

    async def test_save_config_stores_blob(self):
        await node_service.create_node(
            self.conn, NodeCreate(id="tokyo01", label="n")
        )
        payload = {"inbounds": [], "outbounds": []}

        self.assertEqual(
            await node_service.save_config(self.conn, "tokyo01", payload),
            (True, []),
        )

        node = await node_service.get_node_out(self.conn, "tokyo01")
        self.assertTrue(node["has_config"])

    async def test_save_config_missing_node_returns_missing(self):
        self.assertEqual(
            await node_service.save_config(self.conn, "ghost", {}),
            (False, []),
        )

    async def test_save_config_rejects_qualified_tags_without_saving(self):
        await node_service.create_node(
            self.conn, NodeCreate(id="tokyo01", label="n")
        )
        payload = {"inbounds": [{"tag": "reality-tokyo01"}], "outbounds": []}

        exists, errors = await node_service.save_config(
            self.conn, "tokyo01", payload
        )

        self.assertTrue(exists)
        self.assertEqual(len(errors), 1)
        node = await node_service.get_node_out(self.conn, "tokyo01")
        self.assertFalse(node["has_config"])


if __name__ == "__main__":
    unittest.main()
