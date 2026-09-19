"""Tests for the node admin API: CRUD, config, runtime pane, introspection.

Why TestClient: these endpoints are thin HTTP over the services, so the
interesting assertions are status codes and shapes — exactly what an HTTP
test pins. The database is a throwaway; nothing is pushed anywhere (M3):
agents converge on their next heartbeat.
"""

import unittest

from fastapi.testclient import TestClient

from tests.support import cleanup_db, make_test_app, open_fresh_db_sync


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
    """The /api/admin/nodes surface over a throwaway backend."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)
        self.client = TestClient(make_test_app(self.conn))

    def _create_node(self, node_id="tokyo01", address="funky.example.com"):
        """POST one node and return the response."""
        return self.client.post("/api/admin/nodes", json={
            "id": node_id, "label": "Tokyo 01", "address": address,
        })

    def test_create_then_list_then_get(self):
        response = self._create_node()

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["has_config"], False)
        listing = self.client.get("/api/admin/nodes")
        self.assertEqual([n["id"] for n in listing.json()], ["tokyo01"])
        got = self.client.get("/api/admin/nodes/tokyo01")
        self.assertEqual(got.json()["label"], "Tokyo 01")
        missing = self.client.get("/api/admin/nodes/ghost")
        self.assertEqual(missing.status_code, 404)

    def test_create_rejects_duplicate_and_bad_ids(self):
        self._create_node()

        self.assertEqual(self._create_node().status_code, 409)
        for bad_id in ("Tokyo01", "tokyo-01", "a" * 33):
            response = self.client.post("/api/admin/nodes", json={
                "id": bad_id, "label": "x",
            })
            self.assertEqual(response.status_code, 422, bad_id)

    def test_update_merges_partial_fields(self):
        self._create_node()

        response = self.client.put("/api/admin/nodes/tokyo01", json={
            "label": "Tokyo 01 (new)",
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["label"], "Tokyo 01 (new)")
        self.assertEqual(response.json()["address"], "funky.example.com")

    def test_config_roundtrip_and_runtime_pane(self):
        self._create_node()

        put = self.client.put("/api/admin/nodes/tokyo01/config", json=_config())
        self.assertEqual(put.status_code, 200)

        got = self.client.get("/api/admin/nodes/tokyo01/config")
        self.assertEqual(got.json(), _config())
        runtime = self.client.get("/api/admin/nodes/tokyo01/config/runtime")
        self.assertEqual(runtime.status_code, 200)
        self.assertIn("inbounds", runtime.json()["config"])
        self.assertTrue(runtime.json()["hash"])
        self.assertIsInstance(runtime.json()["warnings"], list)
        self.assertTrue(
            self.client.get("/api/admin/nodes/tokyo01").json()["has_config"]
        )

    def test_config_rejects_prequalified_tags_without_saving(self):
        self._create_node()
        payload = dict(_config())
        payload["inbounds"] = [dict(_config()["inbounds"][0], tag="reality-tokyo01")]

        response = self.client.put("/api/admin/nodes/tokyo01/config", json=payload)

        self.assertEqual(response.status_code, 422)
        self.assertIn("reality-tokyo01", response.json()["detail"][0])
        self.assertEqual(
            self.client.get("/api/admin/nodes/tokyo01/config").status_code, 404
        )

    def test_config_endpoints_404_without_config(self):
        self._create_node()

        for path in ("/api/admin/nodes/tokyo01/config",
                     "/api/admin/nodes/tokyo01/config/runtime"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 404, path)

    def test_tag_introspection_503_without_config_and_404_for_ghost(self):
        self._create_node()

        self.assertEqual(
            self.client.get("/api/admin/nodes/tokyo01/inbounds").status_code, 503
        )
        self.assertEqual(
            self.client.get("/api/admin/nodes/ghost/inbounds").status_code, 404
        )

    def test_inbounds_and_outbounds_summaries(self):
        self._create_node()
        self.client.put("/api/admin/nodes/tokyo01/config", json=_config())

        inbounds = self.client.get("/api/admin/nodes/tokyo01/inbounds").json()
        self.assertEqual(
            inbounds,
            [{"tag": "reality", "protocol": "vless",
              "network": "", "security": ""}],
        )
        outbounds = self.client.get("/api/admin/nodes/tokyo01/outbounds").json()
        self.assertEqual(
            outbounds, [{"tag": "niigata", "protocol": "freedom"}]
        )

    def test_status_counts_nodes_and_users(self):
        self._create_node()
        self.client.post("/api/admin/users", json={
            "username": "alice",
            "access": {"tokyo01": {"allowed_inbounds": [], "allowed_outbounds": []}},
        })

        status = self.client.get("/api/admin/status").json()

        self.assertEqual(status, {"node_count": 1, "user_count": 1})


if __name__ == "__main__":
    unittest.main()
