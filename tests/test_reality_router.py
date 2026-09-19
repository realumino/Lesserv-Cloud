"""Tests for the REALITY router endpoints, called directly (no HTTP layer).

Run from the repo root:
    uv run python -m unittest tests.test_reality_router -v
"""

import unittest

from fastapi import HTTPException

from db import create_node, set_node_config
from routers import admin_reality
from services import reality_service
from tests.support import cleanup_db, open_fresh_db_sync


def _reality_config():
    """One REALITY inbound and one plain one — the minimum the router needs."""
    return {
        "inbounds": [
            {
                "tag": "REALITY",
                "protocol": "vless",
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {"privateKey": "x"},
                },
            },
            {"tag": "PLAIN", "protocol": "vless"},
        ],
        "outbounds": [],
    }


class TestRealityRouter(unittest.IsolatedAsyncioTestCase):
    """Node-scoped reality endpoints over a throwaway database."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

    async def _seed(self, node_id="tokyo01", config=_reality_config()):
        """Create the node and paste its config directly."""
        await create_node(self.conn, {
            "id": node_id, "label": "n", "address": "", "created_at": 1,
        })
        if config is not None:
            await set_node_config(self.conn, node_id, config)

    async def test_get_keys_returns_envelope(self):
        await self._seed()

        result = await admin_reality.get_reality_keys("tokyo01", conn=self.conn)

        self.assertEqual(result["keys"][0]["inbound"], "REALITY")
        self.assertIsNone(result["keys"][0]["public_key"])

    async def test_get_keys_404_for_ghost_and_configless_node(self):
        with self.assertRaises(HTTPException) as ctx:
            await admin_reality.get_reality_keys("ghost", conn=self.conn)
        self.assertEqual(ctx.exception.status_code, 404)

        await self._seed(config=None)
        with self.assertRaises(HTTPException) as ctx:
            await admin_reality.get_reality_keys("tokyo01", conn=self.conn)
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_rotate_all_rotates_every_reality_inbound(self):
        await self._seed()
        await reality_service.ensure_keys(self.conn, "tokyo01", _reality_config())
        before = await reality_service.key_map(self.conn, "tokyo01")

        result = await admin_reality.rotate_all_keys("tokyo01", conn=self.conn)

        self.assertEqual(result, {"rotated": ["REALITY"]})
        after = await reality_service.key_map(self.conn, "tokyo01")
        self.assertNotEqual(after["REALITY"], before["REALITY"])

    async def test_rotate_all_404_when_no_reality_inbound(self):
        await self._seed(config={
            "inbounds": [{"tag": "PLAIN", "protocol": "vless"}],
            "outbounds": [],
        })

        with self.assertRaises(HTTPException) as ctx:
            await admin_reality.rotate_all_keys("tokyo01", conn=self.conn)
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_rotate_one_returns_new_public_key(self):
        await self._seed()

        result = await admin_reality.rotate_key("tokyo01", "REALITY", conn=self.conn)

        self.assertEqual(result["inbound"], "REALITY")
        self.assertIsNotNone(result["public_key"])

    async def test_rotate_one_404_for_unknown_and_non_reality_tags(self):
        await self._seed()

        for tag in ("NOPE", "PLAIN"):
            with self.assertRaises(HTTPException) as ctx:
                await admin_reality.rotate_key("tokyo01", tag, conn=self.conn)
            self.assertEqual(ctx.exception.status_code, 404, tag)


if __name__ == "__main__":
    unittest.main()
