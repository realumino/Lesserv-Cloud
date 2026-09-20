"""Render invariants over the admin runtime pane and the node protocol.

WHY HTTP: the render service has no direct API of its own — its output
is what the runtime pane shows and what an agent fetches. These tests
carry over the unique invariants from the old service-level file:
deterministic hashing, per-node independence, storage stays local, and
malformed configs warn instead of breaking.
"""

import unittest

from tests.workerd.harness import client, uid


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


class TestRenderInvariants(unittest.TestCase):
    """Deterministic, per-node, tolerant of bad pasted configs."""

    def setUp(self):
        self.node = uid("n")
        self.client = client()
        self.client.post("/api/admin/nodes", json={
            "id": self.node, "label": self.node,
            "address": "funky.example.com"})

    def _user(self, username=None, node_id=None, status=None):
        """Create a user with reality/niigata access via the API."""
        payload = {"username": username or uid("alice"), "access": {
            node_id or self.node: {
                "allowed_inbounds": ["reality"],
                "allowed_outbounds": ["niigata"],
            }}}
        if status:
            payload["status"] = status
        return self.client.post("/api/admin/users", json=payload)

    def _runtime(self, node_id=None):
        return self.client.get(
            f"/api/admin/nodes/{node_id or self.node}/config/runtime").json()

    def test_disabled_user_is_excluded_from_clients(self):
        self.client.put(
            f"/api/admin/nodes/{self.node}/config", json=_config())
        self._user(status="active")
        disabled = self._user(status="disabled")

        runtime = self._runtime()

        self.assertEqual(disabled.status_code, 201)
        clients = runtime["config"]["inbounds"][0]["settings"]["clients"]
        self.assertEqual(len(clients), 1)
        self.assertTrue(clients[0]["email"].endswith(f"@{self.node}-niigata"))

    def test_malformed_config_is_skipped_with_a_warning(self):
        self.client.put(
            f"/api/admin/nodes/{self.node}/config",
            json={"inbounds": "not a list"})

        sync = self.client.get(f"/api/admin/nodes/{self.node}/sync").json()

        self.assertIsNone(sync["desired_hash"])
        self.assertEqual(len(sync["warnings"]), 1)
        self.assertIn("malformed", sync["warnings"][0])

    def test_renders_per_node_independently(self):
        """Same tags on two nodes produce two different rendered configs."""
        other = uid("n")
        self.client.post("/api/admin/nodes", json={
            "id": other, "label": other, "address": "funky.example.com"})
        self.client.put(f"/api/admin/nodes/{other}/config",
                        json=_config(outbound_tag="other"))
        self.client.put(
            f"/api/admin/nodes/{self.node}/config", json=_config())
        self._user(node_id=self.node)
        self._user(node_id=other)

        mine = self._runtime()["config"]
        theirs = self._runtime(other)["config"]

        self.assertEqual(
            mine["routing"]["rules"],
            [{"user": [f"regexp:.*@{self.node}-niigata$"],
              "outboundTag": f"{self.node}-niigata"}],
        )
        self.assertEqual(
            theirs["routing"]["rules"],
            [{"user": [f"regexp:.*@{other}-other$"],
              "outboundTag": f"{other}-other"}],
        )

    def test_storage_stays_local_runtime_is_qualified(self):
        """Qualified tags exist only in the render, never in storage."""
        self.client.put(
            f"/api/admin/nodes/{self.node}/config", json=_config())
        self._user(node_id=self.node)

        stored = self.client.get(
            f"/api/admin/nodes/{self.node}/config").json()
        runtime = self._runtime()["config"]

        self.assertEqual(stored["inbounds"][0]["tag"], "reality")
        self.assertEqual(
            runtime["inbounds"][0]["tag"], f"reality-{self.node}")
        self.assertNotIn(f"reality-{self.node}", repr(stored))

    def test_same_state_renders_the_same_hash(self):
        self.client.put(
            f"/api/admin/nodes/{self.node}/config", json=_config())
        self._user(node_id=self.node)

        first = self._runtime()
        second = self._runtime()

        self.assertEqual(first["hash"], second["hash"])


if __name__ == "__main__":
    unittest.main()
