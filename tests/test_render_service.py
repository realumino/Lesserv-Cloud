"""Tests for the render service: the per-node render path.

Why this file exists: rendering is the heart of the control plane. These
tests pin its contract — deterministic, per-node, tolerant of a missing or
malformed config — and the content hash the agent protocol (M3) compares.
"""

import unittest

import db
from services import render_service
from tests.support import cleanup_db, open_fresh_db_sync


def _config(outbound_tag="niigata"):
    """An authored config with local tags, in the shape an admin pastes."""
    return {
        "inbounds": [
            {
                "tag": "reality",
                "protocol": "vless",
                "port": 443,
                "settings": {"clients": []},
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {"privateKey": "operator-key"},
                },
            },
        ],
        "outbounds": [{"tag": outbound_tag, "protocol": "freedom"}],
    }


class TestNodeUsers(unittest.IsolatedAsyncioTestCase):
    """The projection from access rows to the archived user shape."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

    async def _seed(self, username="alice", status="active", node_id="tokyo01"):
        """Insert a user and an access row the way the service layer would."""
        await db.create_user(self.conn, {
            "username": username, "status": status,
            "expire": None, "note": None, "created_at": 1,
        })
        await db.upsert_access(
            self.conn, username, node_id,
            ["reality"], ["niigata"], {"niigata": "u1"},
        )

    async def test_rebuilds_email_keyed_uuid_map(self):
        await self._seed()

        users = await render_service.node_users(self.conn, "tokyo01")

        self.assertEqual(users, [{
            "username": "alice",
            "status": "active",
            "allowed_inbounds": ["reality"],
            "allowed_outbounds": ["niigata"],
            "uuids": {"alice@niigata": "u1"},
        }])

    async def test_status_passes_through_for_the_pure_core_to_filter(self):
        await self._seed(status="disabled")

        users = await render_service.node_users(self.conn, "tokyo01")

        self.assertEqual(users[0]["status"], "disabled")


class TestDesiredConfig(unittest.IsolatedAsyncioTestCase):
    """The full per-node render: projection, keys, fill, hash."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

    async def _seed_node(self, node_id="tokyo01", config=None):
        await db.create_node(self.conn, {
            "id": node_id, "label": node_id,
            "address": "funky.example.com", "created_at": 1,
        })
        if config is not None:
            await db.set_node_config(self.conn, node_id, config)

    async def _seed_user(self, username="alice", node_id="tokyo01", status="active"):
        await db.create_user(self.conn, {
            "username": username, "status": status,
            "expire": None, "note": None, "created_at": 1,
        })
        await db.upsert_access(
            self.conn, username, node_id,
            ["reality"], ["niigata"], {"niigata": "u1"},
        )

    async def test_no_node_or_no_config_renders_nothing(self):
        self.assertEqual(await render_service.desired_config(self.conn, "ghost"), (None, []))

        await self._seed_node(config=None)
        self.assertEqual(
            await render_service.desired_config(self.conn, "tokyo01"), (None, [])
        )

    async def test_renders_clients_rules_and_injected_key(self):
        await self._seed_node(config=_config())
        await self._seed_user()

        runtime, warnings = await render_service.desired_config(self.conn, "tokyo01")
        node = await db.get_node(self.conn, "tokyo01")

        self.assertEqual(warnings, [])
        self.assertEqual(
            runtime["inbounds"][0]["tag"], "reality-tokyo01"
        )
        self.assertEqual(
            runtime["inbounds"][0]["settings"]["clients"],
            [{"id": "u1", "email": "alice@tokyo01-niigata"}],
        )
        self.assertEqual(
            runtime["routing"]["rules"],
            [{"user": ["regexp:.*@tokyo01-niigata$"], "outboundTag": "tokyo01-niigata"}],
        )
        injected = runtime["inbounds"][0]["streamSettings"]["realitySettings"]
        self.assertNotEqual(injected["privateKey"], "operator-key")
        # Qualification is output-only: storage retains the local config.
        self.assertEqual(node["config_json"], _config())

    async def test_renders_per_node_independently(self):
        """Same tags on two nodes produce two different rendered configs."""
        await self._seed_node("tokyo01", config=_config())
        await self._seed_node("toyama01", config=_config(outbound_tag="other"))
        await self._seed_user("alice", "tokyo01")
        await self._seed_user("bob", "toyama01")

        tokyo, _ = await render_service.desired_config(self.conn, "tokyo01")
        toyama, _ = await render_service.desired_config(self.conn, "toyama01")

        self.assertEqual(
            tokyo["routing"]["rules"],
            [{"user": ["regexp:.*@tokyo01-niigata$"], "outboundTag": "tokyo01-niigata"}],
        )
        self.assertEqual(
            toyama["routing"]["rules"],
            [{"user": ["regexp:.*@toyama01-other$"], "outboundTag": "toyama01-other"}],
        )

    async def test_disabled_user_is_excluded_from_clients(self):
        await self._seed_node(config=_config())
        await self._seed_user("alice", status="active")
        await self._seed_user("bob", status="disabled")

        runtime, _ = await render_service.desired_config(self.conn, "tokyo01")

        self.assertEqual(
            runtime["inbounds"][0]["settings"]["clients"],
            [{"id": "u1", "email": "alice@tokyo01-niigata"}],
        )

    async def test_malformed_config_is_skipped_with_a_warning(self):
        await self._seed_node(config={"inbounds": "not a list"})

        runtime, warnings = await render_service.desired_config(self.conn, "tokyo01")

        self.assertIsNone(runtime)
        self.assertEqual(len(warnings), 1)
        self.assertIn("malformed", warnings[0])

    async def test_same_state_renders_the_same_hash(self):
        await self._seed_node(config=_config())
        await self._seed_user()

        first, _ = await render_service.desired_config(self.conn, "tokyo01")
        first_hash = render_service.config_hash(first)
        second, _ = await render_service.desired_config(self.conn, "tokyo01")

        self.assertEqual(first, second)
        self.assertEqual(first_hash, render_service.config_hash(second))

    async def test_hash_changes_when_access_changes(self):
        await self._seed_node(config=_config())
        await self._seed_user()
        first, _ = await render_service.desired_config(self.conn, "tokyo01")

        await self._seed_user("bob")
        second, _ = await render_service.desired_config(self.conn, "tokyo01")

        self.assertNotEqual(
            render_service.config_hash(first), render_service.config_hash(second)
        )


if __name__ == "__main__":
    unittest.main()
