"""Tests for the REALITY key service, per node.

Run from the repo root:
    uv run python -m unittest tests.test_reality_service -v
"""

import unittest

from core import x25519
from services import reality_service
from tests.support import cleanup_db, open_fresh_db_sync


def _config():
    """A small config with one REALITY inbound and one plain inbound."""
    return {
        "inbounds": [
            {
                "tag": "REALITY",
                "protocol": "vless",
                "settings": {"clients": []},
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {"privateKey": "operator-owned-key"},
                },
            },
            {"tag": "PLAIN", "protocol": "vless", "settings": {"clients": []}},
        ],
        "outbounds": [{"tag": "OUT", "protocol": "freedom"}],
    }


class TestRealityService(unittest.IsolatedAsyncioTestCase):
    """Generation, per-node scoping, rotation, and listing."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

    async def test_ensure_generates_and_stores_key_for_missing_tag(self):
        keys = await reality_service.ensure_keys(self.conn, "tokyo01", _config())

        self.assertIn("REALITY", keys)
        self.assertEqual(keys, await reality_service.key_map(self.conn, "tokyo01"))

    async def test_ensure_reuses_existing_key(self):
        first = await reality_service.ensure_keys(self.conn, "tokyo01", _config())
        await reality_service.rotate_key(self.conn, "tokyo01", "REALITY")

        second = await reality_service.ensure_keys(self.conn, "tokyo01", _config())

        self.assertNotEqual(second["REALITY"], first["REALITY"])

    async def test_keys_are_scoped_per_node_for_the_same_tag(self):
        """Two nodes with the same inbound tag hold two independent keys."""
        await reality_service.ensure_keys(self.conn, "tokyo01", _config())
        await reality_service.ensure_keys(self.conn, "toyama01", _config())

        tokyo = await reality_service.key_map(self.conn, "tokyo01")
        toyama = await reality_service.key_map(self.conn, "toyama01")

        self.assertIn("REALITY", tokyo)
        self.assertIn("REALITY", toyama)
        self.assertNotEqual(tokyo["REALITY"], toyama["REALITY"])

    async def test_non_reality_inbound_gets_no_key(self):
        await reality_service.ensure_keys(self.conn, "tokyo01", _config())

        self.assertNotIn("PLAIN", await reality_service.key_map(self.conn, "tokyo01"))

    async def test_rotation_replaces_key_and_timestamp(self):
        await reality_service.ensure_keys(self.conn, "tokyo01", _config())
        old = await reality_service.key_map(self.conn, "tokyo01")

        await reality_service.rotate_key(self.conn, "tokyo01", "REALITY")

        new = await reality_service.key_map(self.conn, "tokyo01")
        self.assertNotEqual(new["REALITY"], old["REALITY"])

    async def test_public_key_is_derived_never_stored(self):
        await reality_service.ensure_keys(self.conn, "tokyo01", _config())

        public = await reality_service.public_key(self.conn, "tokyo01", "REALITY")

        self.assertEqual(public, x25519.derive_public_key(
            (await reality_service.key_map(self.conn, "tokyo01"))["REALITY"]
        ))

    async def test_public_key_none_for_unknown_tag(self):
        self.assertIsNone(
            await reality_service.public_key(self.conn, "tokyo01", "NOPE")
        )

    async def test_list_keys_follows_config_order_with_nulls_when_pending(self):
        rows = await reality_service.list_keys(self.conn, "tokyo01", _config())

        self.assertEqual(
            rows,
            [{"inbound": "REALITY", "public_key": None, "created_at": None}],
        )

    async def test_list_keys_fills_public_key_after_ensure(self):
        await reality_service.ensure_keys(self.conn, "tokyo01", _config())

        rows = await reality_service.list_keys(self.conn, "tokyo01", _config())

        self.assertEqual(rows[0]["inbound"], "REALITY")
        self.assertIsNotNone(rows[0]["public_key"])
        self.assertGreater(rows[0]["created_at"], 0)


if __name__ == "__main__":
    unittest.main()
