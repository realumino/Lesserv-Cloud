"""REALITY key behavior over the admin API and the sealed-at-rest check.

WHY HTTP + one D1 read: generation, per-node scoping, and rotation are
observable through the reality endpoints; "sealed at rest" is the one
invariant that lives in the database, so it is asserted with a single
`d1 execute` read against the plane's local D1. The private key never
appears in any API response — only derived public keys.
"""

import unittest

from tests.workerd.harness import client, d1_query, uid


def _reality_config():
    """One REALITY inbound and one plain one — the minimum the router needs.

    WHY `settings` on both: the render choke point (which the runtime pane
    triggers) treats a vless inbound without `settings` as malformed and
    skips the render entirely; the old service-level tests bypassed that
    check, HTTP cannot.
    """
    return {
        "inbounds": [
            {
                "tag": "REALITY",
                "protocol": "vless",
                "settings": {"clients": []},
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {"privateKey": "x"},
                },
            },
            {"tag": "PLAIN", "protocol": "vless", "settings": {"clients": []}},
        ],
        "outbounds": [],
    }


def _plain_config():
    """A config with no REALITY inbound at all."""
    return {
        "inbounds": [
            {"tag": "PLAIN", "protocol": "vless", "settings": {"clients": []}}
        ],
        "outbounds": [],
    }


class TestRealityApi(unittest.TestCase):
    """Node-scoped reality endpoints over a live plane."""

    def setUp(self):
        self.node = uid("n")
        self.client = client()
        self.client.post("/api/admin/nodes", json={
            "id": self.node, "label": "n", "address": ""})

    def _put_config(self, config):
        put = self.client.put(
            f"/api/admin/nodes/{self.node}/config", json=config)
        assert put.status_code == 200, put.text

    def _ensure(self, node_id=None):
        """Trigger key generation through the runtime render choke point."""
        runtime = self.client.get(
            f"/api/admin/nodes/{node_id or self.node}/config/runtime")
        assert runtime.status_code == 200, runtime.text

    def _keys(self, node_id=None):
        return self.client.get(
            f"/api/admin/nodes/{node_id or self.node}/reality").json()["keys"]

    def test_get_keys_returns_envelope_with_null_public_key(self):
        self._put_config(_reality_config())

        keys = self._keys()

        self.assertEqual(keys[0]["inbound"], "REALITY")
        self.assertIsNone(keys[0]["public_key"])

    def test_get_keys_404_for_ghost_and_configless_node(self):
        self.assertEqual(
            self.client.get("/api/admin/nodes/ghost/reality").status_code, 404)

        response = self.client.get(f"/api/admin/nodes/{self.node}/reality")
        self.assertEqual(response.status_code, 404)

    def test_rotate_all_rotates_every_reality_inbound(self):
        self._put_config(_reality_config())
        self._ensure()
        before = self._keys()

        result = self.client.post(
            f"/api/admin/nodes/{self.node}/reality/rotate").json()

        self.assertEqual(result, {"rotated": ["REALITY"]})
        after = self._keys()
        self.assertNotEqual(after[0]["public_key"], before[0]["public_key"])

    def test_rotate_all_404_when_no_reality_inbound(self):
        self._put_config(_plain_config())

        response = self.client.post(
            f"/api/admin/nodes/{self.node}/reality/rotate")

        self.assertEqual(response.status_code, 404)

    def test_rotate_one_returns_new_public_key(self):
        self._put_config(_reality_config())

        result = self.client.post(
            f"/api/admin/nodes/{self.node}/reality/REALITY/rotate").json()

        self.assertEqual(result["inbound"], "REALITY")
        self.assertIsNotNone(result["public_key"])

    def test_rotate_one_404_for_unknown_and_non_reality_tags(self):
        self._put_config(_reality_config())

        for tag in ("NOPE", "PLAIN"):
            response = self.client.post(
                f"/api/admin/nodes/{self.node}/reality/{tag}/rotate")
            self.assertEqual(response.status_code, 404, tag)

    def test_keys_are_scoped_per_node_for_the_same_tag(self):
        """Two nodes with the same inbound tag hold two independent keys."""
        other = uid("n")
        self.client.post("/api/admin/nodes", json={
            "id": other, "label": "n", "address": ""})
        self.client.put(f"/api/admin/nodes/{other}/config",
                        json=_reality_config())
        self._put_config(_reality_config())
        self._ensure(other)
        self._ensure()

        mine = self._keys()
        theirs = self._keys(other)

        self.assertNotEqual(mine[0]["public_key"], theirs[0]["public_key"])

    def test_private_key_is_never_returned_by_the_api(self):
        self._put_config(_reality_config())
        self._ensure()

        for node_id in (self.node,):
            body = repr(self.client.get(
                f"/api/admin/nodes/{node_id}/reality").json())
            self.assertNotIn("privateKey", body)

    def test_keys_are_sealed_at_rest(self):
        """The stored private key is AES-GCM ciphertext, never plaintext."""
        self._put_config(_reality_config())
        self._ensure()

        rows = d1_query(
            "SELECT substr(private_key, 1, 3) AS prefix FROM reality_keys "
            f"WHERE node_id = '{self.node}'"
        )

        self.assertTrue(rows, "no keys stored for the node")
        for row in rows:
            self.assertEqual(row["prefix"], "v1:")


if __name__ == "__main__":
    unittest.main()
