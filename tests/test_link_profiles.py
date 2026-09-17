"""Tests for the link-profile admin API.

Why TestClient: profiles are validated HTTP resources with their own
identity, status codes, and side-effect contract. The database is a
throwaway; render-sync mocking proves profile writes never touch the local
runtime pipeline.
"""

import unittest
from unittest import mock

from fastapi.testclient import TestClient

from services import xray_service
from tests.support import cleanup_db, make_test_app, open_fresh_db_sync


def _config():
    """An authored config with the inbound a CDN-style profile attaches to."""
    return {
        "inbounds": [
            {
                "tag": "xhttp",
                "protocol": "vless",
                "port": 8080,
                "settings": {"clients": []},
                "streamSettings": {"network": "xhttp"},
            },
        ],
        "outbounds": [{"tag": "niigata", "protocol": "freedom"}],
    }


def _profile(profile_id="cdn", inbound="xhttp"):
    """A valid CDN-style profile payload."""
    return {
        "id": profile_id,
        "inbound_tag": inbound,
        "label": "CDN",
        "overrides": {
            "address": "cdn.example.com",
            "port": 443,
            "security": "tls",
            "sni": "cdn.example.com",
        },
    }


class AdminLinkProfileApi(unittest.TestCase):
    """The /api/admin/nodes/{id}/link-profiles surface."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)
        sync_patch = mock.patch.object(xray_service, "sync_node")
        self.sync_mock = sync_patch.start()
        self.addCleanup(sync_patch.stop)
        self.client = TestClient(make_test_app(self.conn))
        response = self.client.post("/api/admin/nodes", json={
            "id": "tokyo01", "label": "Tokyo 01", "address": "funky.example.com",
        })
        assert response.status_code == 201, response.text
        put = self.client.put("/api/admin/nodes/tokyo01/config", json=_config())
        assert put.status_code == 200, put.text
        self.sync_mock.reset_mock()

    def test_create_get_update_delete_roundtrip(self):
        created = self.client.post(
            "/api/admin/nodes/tokyo01/link-profiles", json=_profile()
        )

        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["id"], "cdn")
        self.assertEqual(created.json()["inbound_tag"], "xhttp")
        listed = self.client.get("/api/admin/nodes/tokyo01/link-profiles")
        self.assertEqual([profile["id"] for profile in listed.json()], ["cdn"])
        fetched = self.client.get("/api/admin/nodes/tokyo01/link-profiles/cdn")
        self.assertEqual(fetched.json()["label"], "CDN")

        updated = self.client.put(
            "/api/admin/nodes/tokyo01/link-profiles/cdn",
            json={"label": "CDN Edge", "overrides": {"address": "edge.example.com"}},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["label"], "CDN Edge")

        deleted = self.client.delete("/api/admin/nodes/tokyo01/link-profiles/cdn")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(
            self.client.get("/api/admin/nodes/tokyo01/link-profiles/cdn").status_code,
            404,
        )

    def test_profile_writes_never_sync_the_runtime(self):
        self.client.post("/api/admin/nodes/tokyo01/link-profiles", json=_profile())
        self.client.put(
            "/api/admin/nodes/tokyo01/link-profiles/cdn", json={"label": "CDN Edge"}
        )
        self.client.delete("/api/admin/nodes/tokyo01/link-profiles/cdn")

        self.sync_mock.assert_not_called()

    def test_duplicate_unknown_and_missing_profiles(self):
        self.client.post("/api/admin/nodes/tokyo01/link-profiles", json=_profile())

        duplicate = self.client.post(
            "/api/admin/nodes/tokyo01/link-profiles", json=_profile()
        )
        unknown_inbound = self.client.post(
            "/api/admin/nodes/tokyo01/link-profiles", json=_profile("other", "ghost")
        )
        ghost_node = self.client.post(
            "/api/admin/nodes/ghost/link-profiles", json=_profile()
        )
        missing = self.client.get("/api/admin/nodes/tokyo01/link-profiles/ghost")

        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(unknown_inbound.status_code, 422)
        self.assertEqual(ghost_node.status_code, 404)
        self.assertEqual(missing.status_code, 404)

    def test_invalid_slug_label_and_overrides_are_422(self):
        bad_id = self.client.post(
            "/api/admin/nodes/tokyo01/link-profiles",
            json=_profile("Bad ID"),
        )
        bad_label = self.client.post(
            "/api/admin/nodes/tokyo01/link-profiles",
            json={**_profile("bad-label"), "label": "  "},
        )
        bad_override = self.client.post(
            "/api/admin/nodes/tokyo01/link-profiles",
            json={**_profile("bad-override"), "overrides": {"pbk": "x"}},
        )
        bad_value = self.client.post(
            "/api/admin/nodes/tokyo01/link-profiles",
            json={**_profile("bad-value"), "overrides": {"port": True}},
        )

        self.assertEqual(bad_id.status_code, 422)
        self.assertEqual(bad_label.status_code, 422)
        self.assertEqual(bad_override.status_code, 422)
        self.assertEqual(bad_value.status_code, 422)


if __name__ == "__main__":
    unittest.main()
