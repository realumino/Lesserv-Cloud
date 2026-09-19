"""Tests for token minting and the admin drift view.

Why TestClient: mint-once semantics (plaintext never stored) and the
desired-vs-applied sync shape are the admin half of the M3 contract —
status codes and shapes, pinned over HTTP against a throwaway backend.
"""

import unittest

from fastapi.testclient import TestClient

from tests.support import cleanup_db, make_test_app, open_fresh_db_sync


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
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)
        self.client = TestClient(make_test_app(self.conn))
        response = self.client.post("/api/admin/nodes", json={
            "id": "tokyo01", "label": "Tokyo 01",
            "address": "funky.example.com",
        })
        assert response.status_code == 201, response.text

    def _mint(self, node_id="tokyo01"):
        """Mint a token and return the plaintext."""
        response = self.client.post(f"/api/admin/nodes/{node_id}/token")
        assert response.status_code == 201, response.text
        return response.json()["token"]

    def _auth(self, token, node_id="tokyo01"):
        """Headers one node sends on every request."""
        return {
            "Authorization": f"Bearer {token}",
            "X-Lesserv-Node": node_id,
        }

    def test_mint_returns_plaintext_once_with_no_store(self):
        response = self.client.post("/api/admin/nodes/tokyo01/token")

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["node_id"], "tokyo01")
        self.assertTrue(body["token"])
        self.assertGreater(body["created_at"], 0)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_mint_never_stores_plaintext(self):
        token = self._mint()

        node = self.client.get("/api/admin/nodes/tokyo01").json()

        self.assertNotIn(token, repr(node))

    def test_sync_pending_before_first_contact(self):
        self.client.put("/api/admin/nodes/tokyo01/config", json=_config())

        sync = self.client.get("/api/admin/nodes/tokyo01/sync").json()

        self.assertEqual(sync["state"], "pending")
        self.assertTrue(sync["desired_hash"])
        self.assertIsNone(sync["applied_hash"])
        self.assertFalse(sync["in_sync"])
        self.assertIsNone(sync["last_seen"])

    def test_sync_null_desired_without_config(self):
        sync = self.client.get("/api/admin/nodes/tokyo01/sync").json()

        self.assertIsNone(sync["desired_hash"])
        self.assertFalse(sync["in_sync"])

    def test_sync_converges_after_fake_agent_apply(self):
        self.client.put("/api/admin/nodes/tokyo01/config", json=_config())
        token = self._mint()
        headers = self._auth(token)
        wanted = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1}).json()["desired_hash"]
        self.client.post("/api/node/report", headers=headers,
                         json={"protocol": 1, "hash": wanted, "ok": True,
                               "stage": "applied"})

        sync = self.client.get("/api/admin/nodes/tokyo01/sync").json()

        self.assertEqual(sync["state"], "active")
        self.assertEqual(sync["desired_hash"], wanted)
        self.assertEqual(sync["applied_hash"], wanted)
        self.assertTrue(sync["in_sync"])
        self.assertIsNotNone(sync["last_seen"])

    def test_sync_shows_failure_without_hiding_drift(self):
        self.client.put("/api/admin/nodes/tokyo01/config", json=_config())
        token = self._mint()
        headers = self._auth(token)
        wanted = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1}).json()["desired_hash"]
        self.client.post("/api/node/report", headers=headers,
                         json={"protocol": 1, "hash": "bad", "ok": False,
                               "stage": "started", "error": "boom"})

        sync = self.client.get("/api/admin/nodes/tokyo01/sync").json()

        self.assertEqual(sync["desired_hash"], wanted)
        self.assertIsNone(sync["applied_hash"])
        self.assertFalse(sync["in_sync"])
        self.assertEqual(sync["last_error"], "boom")
        self.assertEqual(sync["health"], "error:started")

    def test_sync_404_for_unknown_node(self):
        self.assertEqual(
            self.client.get("/api/admin/nodes/ghost/sync").status_code, 404)


if __name__ == "__main__":
    unittest.main()
