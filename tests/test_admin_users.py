"""Tests for the user admin API: CRUD with per-node access, and share links.

Why TestClient: the payload/response shapes and the status-code semantics
(404/409/503/409) are the contract the M5 frontend will build against.
The archived links endpoint's single-node codes carry over; the links now
aggregate across nodes.
"""

import shutil
import tempfile
import unittest
from unittest import mock

from fastapi.testclient import TestClient

import settings
from services import xray_service
from tests.support import cleanup_db, make_test_app, open_fresh_db_sync


def _config(listen="0.0.0.0"):
    """An authored config with one REALITY inbound and one exit."""
    return {
        "inbounds": [
            {
                "tag": "reality",
                "protocol": "vless",
                "listen": listen,
                "port": 443,
                "settings": {"clients": [], "flow": "xtls-rprx-vision"},
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {
                        "serverNames": ["apple.com"],
                        "privateKey": "operator-key",
                        "shortIds": ["1234"],
                    },
                },
            },
        ],
        "outbounds": [{"tag": "niigata", "protocol": "freedom"}],
    }


class AdminUserApi(unittest.TestCase):
    """The /api/admin/users surface over a throwaway backend."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        runtime_patch = mock.patch.object(settings, "RUNTIME_DIR", self.tmpdir)
        runtime_patch.start()
        self.addCleanup(runtime_patch.stop)
        restart_patch = mock.patch.object(xray_service, "restart")
        restart_patch.start()
        self.addCleanup(restart_patch.stop)
        self.client = TestClient(make_test_app(self.conn))

    def _make_node(self, node_id="tokyo01", address="funky.example.com", config=None):
        """Create a node via the API; optionally paste its config."""
        response = self.client.post("/api/admin/nodes", json={
            "id": node_id, "label": "Node", "address": address,
        })
        assert response.status_code == 201, response.text
        if config is not None:
            put = self.client.put(
                f"/api/admin/nodes/{node_id}/config", json=config,
            )
            assert put.status_code == 200, put.text

    def _make_user(self, username="alice", node_id="tokyo01", status=None):
        """Create a user with access to one node via the API."""
        payload = {"username": username, "access": {
            node_id: {"allowed_inbounds": ["reality"],
                      "allowed_outbounds": ["niigata"]},
        }}
        if status:
            payload["status"] = status
        return self.client.post("/api/admin/users", json=payload)

    def test_create_returns_nested_access_with_minted_uuids(self):
        self._make_node()
        response = self._make_user()

        self.assertEqual(response.status_code, 201)
        access = response.json()["access"]["tokyo01"]
        self.assertEqual(access["allowed_outbounds"], ["niigata"])
        uuids = access["uuids"]
        self.assertEqual(set(uuids), {"niigata"})
        self.assertNotEqual(uuids["niigata"], "")

    def test_create_rejects_duplicate_unknown_node_and_bad_username(self):
        self._make_node()
        first = self._make_user()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(self._make_user().status_code, 409)
        ghost = self.client.post("/api/admin/users", json={
            "username": "bob",
            "access": {"nowhere": {"allowed_inbounds": [], "allowed_outbounds": []}},
        })
        self.assertEqual(ghost.status_code, 404)
        bad = self.client.post("/api/admin/users", json={
            "username": "a li", "access": {},
        })
        self.assertEqual(bad.status_code, 422)

    def test_update_and_delete_via_api(self):
        self._make_node()
        self._make_user()

        updated = self.client.put("/api/admin/users/alice", json={"note": "x"})
        self.assertEqual(updated.json()["note"], "x")

        deleted = self.client.delete("/api/admin/users/alice")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.get("/api/admin/users/alice").status_code, 404)
        self.assertEqual(
            self.client.delete("/api/admin/users/alice").status_code, 404
        )

    def test_update_access_map_is_authoritative_membership(self):
        self._make_node("tokyo01")
        self._make_node("toyama01")
        self._make_user()
        self.client.put("/api/admin/users/alice", json={"access": {
            "toyama01": {"allowed_inbounds": [], "allowed_outbounds": []},
        }})

        user = self.client.get("/api/admin/users/alice").json()

        self.assertEqual(set(user["access"]), {"toyama01"})

    def test_links_build_reality_uri_from_node_address_and_stored_key(self):
        """The whole chain: config pasted, key ensured, pbk derived."""
        self._make_node(config=_config())
        self._make_user()

        response = self.client.get("/api/admin/users/alice/links")

        self.assertEqual(response.status_code, 200)
        links = response.json()["links"]
        self.assertEqual(len(links), 1)
        link = links[0]
        self.assertEqual(link["node"], "tokyo01")
        self.assertEqual(link["inbound"], "reality-tokyo01")
        self.assertEqual(link["outbound"], "tokyo01-niigata")
        self.assertEqual(link["email"], "alice@tokyo01-niigata")
        self.assertIsNone(link["profile"])
        self.assertEqual(link["label"], "Node · REALITY → Niigata")
        uri = link["uri"]
        self.assertIn("vless://", uri)
        self.assertIn("funky.example.com:443", uri)
        self.assertIn("security=reality", uri)
        self.assertIn("sid=1234", uri)
        keys = self.client.get("/api/admin/nodes/tokyo01/reality").json()["keys"]
        self.assertIn(f"pbk={keys[0]['public_key']}", uri)

    def test_links_include_one_profile_variant_per_exit(self):
        self._make_node(config=_config())
        self._make_user()
        created = self.client.post("/api/admin/nodes/tokyo01/link-profiles", json={
            "id": "cdn",
            "inbound_tag": "reality",
            "label": "CDN",
            "overrides": {"address": "cdn.example.com", "port": 443},
        })
        assert created.status_code == 201, created.text

        response = self.client.get("/api/admin/users/alice/links")

        self.assertEqual(response.status_code, 200)
        links = response.json()["links"]
        self.assertEqual(len(links), 2)
        self.assertEqual(
            [(link["profile"], link["label"]) for link in links],
            [
                (None, "Node · REALITY → Niigata"),
                ("cdn", "Node · CDN → Niigata"),
            ],
        )
        self.assertIn("cdn.example.com:443", links[1]["uri"])

    def test_links_404_unknown_user(self):
        self.assertEqual(
            self.client.get("/api/admin/users/ghost/links").status_code, 404
        )

    def test_links_503_when_access_exists_but_no_node_config(self):
        self._make_node(config=None)
        self._make_user()

        response = self.client.get("/api/admin/users/alice/links")

        self.assertEqual(response.status_code, 503)

    def test_links_409_when_no_node_has_a_usable_address(self):
        """Config exists (wildcard listen) but neither it nor the node can name a host."""
        self._make_node(address="", config=_config())
        self._make_user()

        response = self.client.get("/api/admin/users/alice/links")

        self.assertEqual(response.status_code, 409)

    def test_links_200_empty_for_user_without_access(self):
        self._make_node(config=_config())
        self.client.post("/api/admin/users", json={"username": "alice"})

        response = self.client.get("/api/admin/users/alice/links")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["links"], [])

    def test_links_warn_for_disabled_user_and_skipped_nodes(self):
        """Disabled users still get links (archived rule); configless nodes warn."""
        self._make_node("tokyo01", config=_config())
        self._make_node("toyama01", config=None)
        response = self.client.post("/api/admin/users", json={
            "username": "alice", "status": "disabled",
            "access": {
                "tokyo01": {"allowed_inbounds": ["reality"],
                            "allowed_outbounds": ["niigata"]},
                "toyama01": {"allowed_inbounds": [], "allowed_outbounds": []},
            },
        })
        assert response.status_code == 201

        body = self.client.get("/api/admin/users/alice/links").json()

        self.assertTrue(body["links"])
        self.assertTrue(
            any("toyama01" in w for w in body["warnings"]), body["warnings"]
        )
        self.assertTrue(
            any("disabled" in w for w in body["warnings"]), body["warnings"]
        )


if __name__ == "__main__":
    unittest.main()
