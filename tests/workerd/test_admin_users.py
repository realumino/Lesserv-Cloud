"""Tests for the user admin API: CRUD with per-node access, and share links.

WHY HTTP: the payload/response shapes and the status-code semantics
(404/409/503/409) are the contract the M5 frontend will build against.
Ported from TestClient to the shared-plane harness with unique ids; the
user-service uuid invariants from test_users.py ride along as HTTP tests
(uuid stability is visible in the GET response).
"""

import unittest

from tests.workerd.harness import client, uid


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
    """The /api/admin/users surface over a live plane."""

    def setUp(self):
        self.node = uid("n")
        self.user = uid("alice")
        self.client = client()

    def _make_node(self, node_id=None, address="funky.example.com", config=None):
        """Create a node via the API; optionally paste its config."""
        response = self.client.post("/api/admin/nodes", json={
            "id": node_id or self.node, "label": "Node", "address": address,
        })
        assert response.status_code == 201, response.text
        if config is not None:
            put = self.client.put(
                f"/api/admin/nodes/{node_id or self.node}/config", json=config,
            )
            assert put.status_code == 200, put.text

    def _make_user(self, username=None, node_id=None, status=None):
        """Create a user with access to one node via the API."""
        payload = {"username": username or self.user, "access": {
            node_id or self.node: {
                "allowed_inbounds": ["reality"],
                "allowed_outbounds": ["niigata"],
            },
        }}
        if status:
            payload["status"] = status
        return self.client.post("/api/admin/users", json=payload)

    def test_create_returns_nested_access_with_minted_uuids(self):
        self._make_node()
        response = self._make_user()

        self.assertEqual(response.status_code, 201)
        access = response.json()["access"][self.node]
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
            "username": uid("bob"),
            "access": {"nowhere": {
                "allowed_inbounds": [], "allowed_outbounds": []}},
        })
        self.assertEqual(ghost.status_code, 404)
        bad = self.client.post("/api/admin/users", json={
            "username": "a li", "access": {},
        })
        self.assertEqual(bad.status_code, 422)

    def test_update_and_delete_via_api(self):
        self._make_node()
        self._make_user()

        updated = self.client.put(f"/api/admin/users/{self.user}",
                                  json={"note": "x"})
        self.assertEqual(updated.json()["note"], "x")

        deleted = self.client.delete(f"/api/admin/users/{self.user}")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(
            self.client.get(f"/api/admin/users/{self.user}").status_code, 404)
        self.assertEqual(
            self.client.delete(f"/api/admin/users/{self.user}").status_code, 404
        )

    def test_update_access_map_is_authoritative_membership(self):
        other = uid("n")
        self._make_node(self.node)
        self._make_node(other)
        self._make_user()
        self.client.put(f"/api/admin/users/{self.user}", json={"access": {
            other: {"allowed_inbounds": [], "allowed_outbounds": []},
        }})

        user = self.client.get(f"/api/admin/users/{self.user}").json()

        self.assertEqual(set(user["access"]), {other})

    def test_update_with_access_adds_exactly_one_new_uuid(self):
        """The uuid rule over HTTP: existing pairs survive, new tags mint."""
        self._make_node()
        created = self._make_user()
        first_uuids = created.json()["access"][self.node]["uuids"]
        self.client.put(f"/api/admin/users/{self.user}", json={"access": {
            self.node: {"allowed_inbounds": ["reality"],
                        "allowed_outbounds": ["niigata", "other"]},
        }})

        uuids = self.client.get(
            f"/api/admin/users/{self.user}").json(
        )["access"][self.node]["uuids"]

        self.assertEqual(uuids["niigata"], first_uuids["niigata"])
        self.assertIn("other", uuids)

    def test_update_without_access_leaves_rows_alone(self):
        """None means "leave unchanged": a note edit keeps membership."""
        self._make_node()
        self._make_user()

        self.client.put(f"/api/admin/users/{self.user}", json={"note": "x"})

        user = self.client.get(f"/api/admin/users/{self.user}").json()
        self.assertIn(self.node, user["access"])

    def test_create_with_no_access_has_empty_access(self):
        self._make_node()
        response = self.client.post("/api/admin/users",
                                    json={"username": self.user})

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["access"], {})

    def test_links_build_reality_uri_from_node_address_and_stored_key(self):
        """The whole chain: config pasted, key ensured at render, pbk derived."""
        self._make_node(config=_config())
        self._make_user()
        runtime = self.client.get(
            f"/api/admin/nodes/{self.node}/config/runtime")
        assert runtime.status_code == 200, runtime.text

        response = self.client.get(f"/api/admin/users/{self.user}/links")

        self.assertEqual(response.status_code, 200)
        links = response.json()["links"]
        self.assertEqual(len(links), 1)
        link = links[0]
        self.assertEqual(link["node"], self.node)
        self.assertEqual(link["inbound"], f"reality-{self.node}")
        self.assertEqual(link["outbound"], f"{self.node}-niigata")
        self.assertEqual(link["email"], f"{self.user}@{self.node}-niigata")
        self.assertIsNone(link["profile"])
        self.assertEqual(link["label"], "Node · REALITY → Niigata")
        uri = link["uri"]
        self.assertIn("vless://", uri)
        self.assertIn("funky.example.com:443", uri)
        self.assertIn("security=reality", uri)
        self.assertIn("sid=1234", uri)
        keys = self.client.get(
            f"/api/admin/nodes/{self.node}/reality").json()["keys"]
        self.assertIn(f"pbk={keys[0]['public_key']}", uri)

    def test_links_include_one_profile_variant_per_exit(self):
        self._make_node(config=_config())
        self._make_user()
        created = self.client.post(
            f"/api/admin/nodes/{self.node}/link-profiles", json={
                "id": "cdn",
                "inbound_tag": "reality",
                "label": "CDN",
                "overrides": {"address": "cdn.example.com", "port": 443},
            })
        assert created.status_code == 201, created.text

        response = self.client.get(f"/api/admin/users/{self.user}/links")

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

        response = self.client.get(f"/api/admin/users/{self.user}/links")

        self.assertEqual(response.status_code, 503)

    def test_links_409_when_no_node_has_a_usable_address(self):
        """Config exists (wildcard listen) but neither it nor the node can name a host."""
        self._make_node(address="", config=_config())
        self._make_user()

        response = self.client.get(f"/api/admin/users/{self.user}/links")

        self.assertEqual(response.status_code, 409)

    def test_links_200_empty_for_user_without_access(self):
        self._make_node(config=_config())
        self.client.post("/api/admin/users", json={"username": self.user})

        response = self.client.get(f"/api/admin/users/{self.user}/links")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["links"], [])

    def test_links_warn_for_disabled_user_and_skipped_nodes(self):
        """Disabled users still get links (archived rule); configless nodes warn."""
        other = uid("n")
        self._make_node(config=_config())
        self._make_node(other, config=None)
        response = self.client.post("/api/admin/users", json={
            "username": self.user, "status": "disabled",
            "access": {
                self.node: {"allowed_inbounds": ["reality"],
                            "allowed_outbounds": ["niigata"]},
                other: {"allowed_inbounds": [], "allowed_outbounds": []},
            },
        })
        assert response.status_code == 201

        body = self.client.get(f"/api/admin/users/{self.user}/links").json()

        self.assertTrue(body["links"])
        self.assertTrue(
            any(other in w for w in body["warnings"]), body["warnings"]
        )
        self.assertTrue(
            any("disabled" in w for w in body["warnings"]), body["warnings"]
        )


if __name__ == "__main__":
    unittest.main()
