"""Tests for the node admin API: CRUD, config, runtime pane, introspection.

WHY HTTP: these endpoints are thin HTTP over the services, so the
interesting assertions are status codes and shapes. Ported from
TestClient to the shared-plane harness: every id is unique (uid) and
list/status assertions are scoped to what this test created.
"""

import unittest

from tests.workerd.harness import client, uid


def _config():
    """A minimal authored config a node could hold."""
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


class AdminNodeApi(unittest.TestCase):
    """The /api/admin/nodes surface over a live plane."""

    def setUp(self):
        self.node = uid("n")

    def _create_node(self, node_id=None, address="funky.example.com"):
        """POST one node and return the response."""
        return client().post("/api/admin/nodes", json={
            "id": node_id or self.node, "label": "Tokyo 01", "address": address,
        })

    def test_create_then_list_then_get(self):
        response = self._create_node()

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["has_config"], False)
        listing = client().get("/api/admin/nodes")
        mine = [n for n in listing.json() if n["id"] == self.node]
        self.assertEqual(len(mine), 1)
        got = client().get(f"/api/admin/nodes/{self.node}")
        self.assertEqual(got.json()["label"], "Tokyo 01")
        missing = client().get("/api/admin/nodes/ghost")
        self.assertEqual(missing.status_code, 404)

    def test_create_rejects_duplicate_and_bad_ids(self):
        self._create_node()

        self.assertEqual(self._create_node().status_code, 409)
        for bad_id in ("Tokyo01", "tokyo-01", "a" * 33):
            response = client().post("/api/admin/nodes", json={
                "id": bad_id, "label": "x",
            })
            self.assertEqual(response.status_code, 422, bad_id)

    def test_update_merges_partial_fields(self):
        self._create_node()

        response = client().put(f"/api/admin/nodes/{self.node}", json={
            "label": "Tokyo 01 (new)",
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["label"], "Tokyo 01 (new)")
        self.assertEqual(response.json()["address"], "funky.example.com")

    def test_config_roundtrip_and_runtime_pane(self):
        self._create_node()
        put = client().put(f"/api/admin/nodes/{self.node}/config", json=_config())
        self.assertEqual(put.status_code, 200)

        got = client().get(f"/api/admin/nodes/{self.node}/config")
        self.assertEqual(got.json(), _config())
        runtime = client().get(f"/api/admin/nodes/{self.node}/config/runtime")
        self.assertEqual(runtime.status_code, 200)
        self.assertIn("inbounds", runtime.json()["config"])
        self.assertTrue(runtime.json()["hash"])
        self.assertIsInstance(runtime.json()["warnings"], list)
        self.assertTrue(
            client().get(f"/api/admin/nodes/{self.node}").json()["has_config"]
        )

    def test_config_rejects_prequalified_tags_without_saving(self):
        self._create_node()
        payload = dict(_config())
        payload["inbounds"] = [dict(
            _config()["inbounds"][0], tag=f"reality-{self.node}"
        )]

        response = client().put(
            f"/api/admin/nodes/{self.node}/config", json=payload)

        self.assertEqual(response.status_code, 422)
        self.assertIn(f"reality-{self.node}", response.json()["detail"][0])
        self.assertEqual(
            client().get(f"/api/admin/nodes/{self.node}/config").status_code, 404
        )

    def test_config_endpoints_404_without_config(self):
        self._create_node()

        for path in (f"/api/admin/nodes/{self.node}/config",
                     f"/api/admin/nodes/{self.node}/config/runtime"):
            response = client().get(path)
            self.assertEqual(response.status_code, 404, path)

    def test_tag_introspection_503_without_config_and_404_for_ghost(self):
        self._create_node()

        self.assertEqual(
            client().get(f"/api/admin/nodes/{self.node}/inbounds").status_code, 503
        )
        self.assertEqual(
            client().get("/api/admin/nodes/ghost/inbounds").status_code, 404
        )

    def test_inbounds_and_outbounds_summaries(self):
        self._create_node()
        client().put(f"/api/admin/nodes/{self.node}/config", json=_config())

        inbounds = client().get(f"/api/admin/nodes/{self.node}/inbounds").json()
        self.assertEqual(
            inbounds,
            [{"tag": "reality", "protocol": "vless",
              "network": "", "security": ""}],
        )
        outbounds = client().get(f"/api/admin/nodes/{self.node}/outbounds").json()
        self.assertEqual(
            outbounds, [{"tag": "niigata", "protocol": "freedom"}]
        )

    def test_status_counts_include_the_nodes_and_users_i_created(self):
        other = uid("n")
        self._create_node()
        self._create_node(other)
        client().post("/api/admin/users", json={
            "username": uid("alice"),
            "access": {self.node: {
                "allowed_inbounds": [], "allowed_outbounds": []}},
        })

        status = client().get("/api/admin/status").json()

        self.assertGreaterEqual(status["node_count"], 2)
        self.assertGreaterEqual(status["user_count"], 1)


if __name__ == "__main__":
    unittest.main()
