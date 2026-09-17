"""Tests for qualified, profile-aware link orchestration.

Why this file exists: share links combine local access, configs, keys, and
profiles. These tests pin the cross-module contract — qualified names,
profile multiplication, readable labels, deterministic order, and warnings
for profiles that no longer match the config.
"""

import unittest
from urllib.parse import quote

import db
from services import link_service
from tests.support import cleanup_db, open_fresh_db_sync


def _config():
    """An authored config with two exits and two distinct inbounds."""
    return {
        "inbounds": [
            {
                "tag": "reality",
                "protocol": "vless",
                "port": 443,
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {
                        "serverNames": ["apple.com"],
                        "privateKey": "sMS4KcvOCag9dZsYPa3sFfVLSn3IGNEI34B7ENhGBFE",
                        "shortIds": ["1234"],
                    },
                },
            },
            {
                "tag": "xhttp",
                "protocol": "vless",
                "port": 8080,
                "streamSettings": {"network": "xhttp"},
            },
        ],
        "outbounds": [
            {"tag": "HK", "protocol": "freedom"},
            {"tag": "JAPAN", "protocol": "freedom"},
        ],
    }


class TestNodeLinks(unittest.IsolatedAsyncioTestCase):
    """Qualified links with direct and profile variants."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

    async def _seed(self, profiles=()):
        await db.create_node(self.conn, {
            "id": "tokyo01", "label": "Tokyo 01",
            "address": "funky.example.com", "created_at": 1,
        })
        await db.set_node_config(self.conn, "tokyo01", _config())
        await db.create_user(self.conn, {
            "username": "alice", "status": "active",
            "expire": None, "note": None, "created_at": 1,
        })
        await db.upsert_access(
            self.conn, "alice", "tokyo01",
            ["reality", "xhttp"], ["HK", "JAPAN"],
            {"HK": "u-hk", "JAPAN": "u-japan"},
        )
        for profile in profiles:
            await db.create_link_profile(self.conn, {
                "node_id": "tokyo01",
                "id": profile["id"],
                "inbound_tag": profile["inbound_tag"],
                "label": profile["label"],
                "overrides": profile["overrides"],
                "created_at": 1,
            })
        node = await db.get_node(self.conn, "tokyo01")
        access = await db.get_access(self.conn, "alice", "tokyo01")
        profiles = await db.list_link_profiles(self.conn, "tokyo01")
        return node, access, profiles

    async def _seed_cdn(self):
        return await self._seed([{
            "id": "cdn",
            "inbound_tag": "xhttp",
            "label": "CDN",
            "overrides": {"address": "cdn.example.com", "port": 443},
        }])

    async def test_profile_adds_one_variant_per_exit(self):
        node, access, profiles = await self._seed_cdn()

        links, warnings = await link_service.node_links(
            self.conn, node, access, "active", profiles
        )

        self.assertEqual(warnings, [])
        self.assertEqual(
            [
                (link["inbound"], link["outbound"], link["profile"])
                for link in links
            ],
            [
                ("reality-tokyo01", "tokyo01-HK", None),
                ("reality-tokyo01", "tokyo01-JAPAN", None),
                ("xhttp-tokyo01", "tokyo01-HK", None),
                ("xhttp-tokyo01", "tokyo01-HK", "cdn"),
                ("xhttp-tokyo01", "tokyo01-JAPAN", None),
                ("xhttp-tokyo01", "tokyo01-JAPAN", "cdn"),
            ],
        )

    async def test_profile_links_use_qualified_names_and_labels(self):
        node, access, profiles = await self._seed_cdn()

        links, _ = await link_service.node_links(
            self.conn, node, access, "active", profiles
        )

        self.assertEqual(links[0]["email"], "alice@tokyo01-HK")
        self.assertEqual(links[0]["label"], "Tokyo 01 · REALITY → Hk")
        self.assertEqual(links[3]["label"], "Tokyo 01 · CDN → Hk")
        self.assertIn("cdn.example.com:443", links[3]["uri"])
        self.assertTrue(
            links[0]["uri"].endswith("#" + quote(links[0]["label"], safe=""))
        )

    async def test_dangling_profile_warns_and_is_ignored(self):
        node, access, _ = await self._seed()
        await db.create_link_profile(self.conn, {
            "node_id": "tokyo01", "id": "ghost", "inbound_tag": "gone",
            "label": "Ghost", "overrides": {}, "created_at": 1,
        })
        profiles = await db.list_link_profiles(self.conn, "tokyo01")

        links, warnings = await link_service.node_links(
            self.conn, node, access, "active", profiles
        )

        self.assertEqual(len(links), 4)
        self.assertEqual(
            warnings, ["profile 'ghost' references unknown inbound 'gone'"]
        )


if __name__ == "__main__":
    unittest.main()
