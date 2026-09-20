"""Tests for token minting and the admin drift view, over a real plane.

WHY HTTP: mint-once semantics (plaintext never stored) and the
desired-vs-applied sync shape are the admin half of the M3 contract —
status codes and shapes, pinned against live workerd + D1.
"""

import unittest

from tests.workerd.harness import client, uid


def _config():
    """A minimal authored config with one inbound and one exit."""
    return {
        "inbounds": [
            {
                "tag": "reality",
                "protocol": "vless",
                "port": 443,
                "settings": {"clients": []},
            },
        ],
        "outbounds": [{"tag": "niigata", "protocol": "freedom"}],
    }


class AdminSyncApi(unittest.TestCase):
    """Token minting plus /sync drift display."""

    def setUp(self):
        self.node = uid("n")
        response = client().post("/api/admin/nodes", json={
            "id": self.node, "label": "Tokyo 01",
            "address": "funky.example.com",
        })
        assert response.status_code == 201, response.text

    def _mint(self, node_id=None):
        """Mint a token and return the plaintext."""
        response = client().post(f"/api/admin/nodes/{node_id or self.node}/token")
        assert response.status_code == 201, response.text
        return response.json()["token"]

    def _auth(self, token, node_id=None):
        """Headers one node sends on every request."""
        return {
            "Authorization": f"Bearer {token}",
            "X-Lesserv-Node": node_id or self.node,
        }

    def test_mint_returns_plaintext_once_with_no_store(self):
        response = client().post(f"/api/admin/nodes/{self.node}/token")

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["node_id"], self.node)
        self.assertTrue(body["token"])
        self.assertGreater(body["created_at"], 0)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_mint_never_stores_plaintext(self):
        token = self._mint()

        node = client().get(f"/api/admin/nodes/{self.node}").json()

        self.assertNotIn(token, repr(node))

    def test_sync_pending_before_first_contact(self):
        client().put(f"/api/admin/nodes/{self.node}/config", json=_config())

        sync = client().get(f"/api/admin/nodes/{self.node}/sync").json()

        self.assertEqual(sync["state"], "pending")
        self.assertTrue(sync["desired_hash"])
        self.assertIsNone(sync["applied_hash"])
        self.assertFalse(sync["in_sync"])
        self.assertIsNone(sync["last_seen"])

    def test_sync_null_desired_without_config(self):
        sync = client().get(f"/api/admin/nodes/{self.node}/sync").json()

        self.assertIsNone(sync["desired_hash"])
        self.assertFalse(sync["in_sync"])

    def test_sync_converges_after_fake_agent_apply(self):
        client().put(f"/api/admin/nodes/{self.node}/config", json=_config())
        token = self._mint()
        headers = self._auth(token)
        wanted = client().post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1}).json()["desired_hash"]
        client().post("/api/node/report", headers=headers,
                      json={"protocol": 1, "hash": wanted, "ok": True,
                            "stage": "applied"})

        sync = client().get(f"/api/admin/nodes/{self.node}/sync").json()

        self.assertEqual(sync["state"], "active")
        self.assertEqual(sync["desired_hash"], wanted)
        self.assertEqual(sync["applied_hash"], wanted)
        self.assertTrue(sync["in_sync"])
        self.assertIsNotNone(sync["last_seen"])

    def test_sync_shows_failure_without_hiding_drift(self):
        client().put(f"/api/admin/nodes/{self.node}/config", json=_config())
        token = self._mint()
        headers = self._auth(token)
        wanted = client().post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1}).json()["desired_hash"]
        client().post("/api/node/report", headers=headers,
                      json={"protocol": 1, "hash": "bad", "ok": False,
                            "stage": "started", "error": "boom"})

        sync = client().get(f"/api/admin/nodes/{self.node}/sync").json()

        self.assertEqual(sync["desired_hash"], wanted)
        self.assertIsNone(sync["applied_hash"])
        self.assertFalse(sync["in_sync"])
        self.assertEqual(sync["last_error"], "boom")
        self.assertEqual(sync["health"], "error:started")

    def test_sync_404_for_unknown_node(self):
        self.assertEqual(
            client().get("/api/admin/nodes/ghost/sync").status_code, 404)


if __name__ == "__main__":
    unittest.main()
