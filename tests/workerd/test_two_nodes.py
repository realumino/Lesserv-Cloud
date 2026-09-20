"""Two nodes on one plane: independent convergence and total isolation.

WHY this file exists: M5's headline claim is that adding node #2 requires no
code change anywhere — the node dimension was general from M1. That claim
is only credible if a second node, built with the same calls as the first,
converges on its own render and can never see the other's data. The fake
agents here are the same HTTP loop the real agent runs; the plane cannot
tell them apart.
"""

import unittest

from tests.workerd.harness import client, uid


def _config(exit_tag):
    """An authored config with one REALITY inbound and one named exit.

    WHY the exit tag is a parameter: two nodes with different exits prove
    the qualified names (`{node}-{exit}`) are per node, not shared.
    """
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
                    "realitySettings": {
                        "serverNames": ["apple.com"],
                        "privateKey": "operator-key",
                        "shortIds": ["1234"],
                    },
                },
            },
        ],
        "outbounds": [{"tag": exit_tag, "protocol": "freedom"}],
    }


def _client_emails(runtime):
    """Every client email across all inbounds of one rendered config."""
    emails = []
    for inbound in runtime.get("inbounds", []):
        for entry in inbound.get("settings", {}).get("clients", []):
            emails.append(entry["email"])
    return emails


def _private_key(runtime):
    """The injected REALITY private key of one rendered config.

    WHY this reads the render and not the database: the panel-owned key
    only becomes visible to a node through the render, and that is the
    artifact the isolation claim is about.
    """
    return runtime["inbounds"][0]["streamSettings"]["realitySettings"]["privateKey"]


class TwoNodeFleet(unittest.TestCase):
    """One plane, two nodes, two fake agents; nothing crosses."""

    def setUp(self):
        self.client = client()
        self.node_a = uid("a")
        self.node_b = uid("b")

    def _make_node(self, node_id, exit_tag, address="funky.example.com"):
        """Create a node and paste its authored config (the generic calls)."""
        response = self.client.post("/api/admin/nodes", json={
            "id": node_id, "label": f"Node {node_id}", "address": address,
        })
        assert response.status_code == 201, response.text
        put = self.client.put(
            f"/api/admin/nodes/{node_id}/config", json=_config(exit_tag))
        assert put.status_code == 200, put.text

    def _mint(self, node_id):
        """Mint one node's bearer token and return the plaintext."""
        response = self.client.post(f"/api/admin/nodes/{node_id}/token")
        assert response.status_code == 201, response.text
        return response.json()["token"]

    def _auth(self, token, node_id):
        """Headers one node sends on every request."""
        return {
            "Authorization": f"Bearer {token}",
            "X-Lesserv-Node": node_id,
        }

    def _heartbeat(self, token, node_id, applied=None):
        """Poll once; return the desired hash the plane named."""
        response = self.client.post(
            "/api/node/heartbeat", headers=self._auth(token, node_id),
            json={"protocol": 1, "applied_hash": applied})
        assert response.status_code == 200, response.text
        return response.json()["desired_hash"]

    def _fetch(self, token, node_id, wanted):
        """Fetch the exact render the heartbeat named, asserting its hash."""
        response = self.client.get(
            "/api/node/config", headers=self._auth(token, node_id),
            params={"hash": wanted})
        assert response.status_code == 200, response.text
        body = response.json()
        self.assertEqual(body["hash"], wanted)
        return body["config"]

    def _report(self, token, node_id, wanted):
        """Report a successful apply of one hash."""
        response = self.client.post(
            "/api/node/report", headers=self._auth(token, node_id),
            json={"protocol": 1, "hash": wanted, "ok": True,
                  "stage": "applied"})
        assert response.status_code == 200, response.text

    def _sync(self, node_id):
        """Read one node's drift view."""
        return self.client.get(
            f"/api/admin/nodes/{node_id}/sync").json()

    def _user(self, username, access):
        """Create one user with the given per-node access map."""
        response = self.client.post(
            "/api/admin/users", json={"username": username, "access": access})
        assert response.status_code == 201, response.text

    def test_two_fake_agents_converge_independently(self):
        shared, only_a = uid("shared"), uid("onlya")
        self._make_node(self.node_a, "alpha")
        self._make_node(self.node_b, "beta")
        self._user(shared, {
            self.node_a: {"allowed_inbounds": ["reality"],
                          "allowed_outbounds": ["alpha"]},
            self.node_b: {"allowed_inbounds": ["reality"],
                          "allowed_outbounds": ["beta"]},
        })
        self._user(only_a, {
            self.node_a: {"allowed_inbounds": ["reality"],
                          "allowed_outbounds": ["alpha"]},
        })
        token_a, token_b = self._mint(self.node_a), self._mint(self.node_b)

        wanted_a = self._heartbeat(token_a, self.node_a)
        wanted_b = self._heartbeat(token_b, self.node_b)

        self.assertNotEqual(wanted_a, wanted_b)
        runtime_a = self._fetch(token_a, self.node_a, wanted_a)
        runtime_b = self._fetch(token_b, self.node_b, wanted_b)
        emails_a, emails_b = _client_emails(runtime_a), _client_emails(runtime_b)
        self.assertIn(f"{shared}@{self.node_a}-alpha", emails_a)
        self.assertIn(f"{only_a}@{self.node_a}-alpha", emails_a)
        self.assertIn(f"{shared}@{self.node_b}-beta", emails_b)
        self.assertFalse(any(e.startswith(f"{only_a}@") for e in emails_b))
        self.assertNotEqual(_private_key(runtime_a), _private_key(runtime_b))

        self._report(token_a, self.node_a, wanted_a)
        self.assertTrue(self._sync(self.node_a)["in_sync"])
        drifting_b = self._sync(self.node_b)
        self.assertFalse(drifting_b["in_sync"])
        self.assertIsNone(drifting_b["applied_hash"])
        self.assertEqual(drifting_b["desired_hash"], wanted_b)

        self._report(token_b, self.node_b, wanted_b)
        settled_b = self._sync(self.node_b)
        self.assertTrue(settled_b["in_sync"])
        self.assertEqual(settled_b["applied_hash"], wanted_b)

    def test_user_edit_on_one_node_leaves_the_other_hash_unchanged(self):
        self._make_node(self.node_a, "alpha")
        self._make_node(self.node_b, "beta")
        token_a, token_b = self._mint(self.node_a), self._mint(self.node_b)
        before_a = self._heartbeat(token_a, self.node_a)
        before_b = self._heartbeat(token_b, self.node_b)

        self._user(uid("alice"), {
            self.node_a: {"allowed_inbounds": ["reality"],
                          "allowed_outbounds": ["alpha"]},
        })

        self.assertNotEqual(self._heartbeat(token_a, self.node_a), before_a)
        self.assertEqual(self._heartbeat(token_b, self.node_b), before_b)

    def test_config_change_on_one_node_leaves_the_other_hash_unchanged(self):
        self._make_node(self.node_a, "alpha")
        self._make_node(self.node_b, "beta")
        token_a, token_b = self._mint(self.node_a), self._mint(self.node_b)
        before_a = self._heartbeat(token_a, self.node_a)
        before_b = self._heartbeat(token_b, self.node_b)

        changed = self.client.put(
            f"/api/admin/nodes/{self.node_b}/config", json=_config("gamma"))
        self.assertEqual(changed.status_code, 200, changed.text)

        self.assertEqual(self._heartbeat(token_a, self.node_a), before_a)
        self.assertNotEqual(self._heartbeat(token_b, self.node_b), before_b)

    def test_cross_node_reads_stay_401(self):
        """A valid token must never unlock another node's endpoints."""
        self._make_node(self.node_a, "alpha")
        self._make_node(self.node_b, "beta")
        token_a = self._mint(self.node_a)

        for method, path, kwargs in [
            ("post", "/api/node/enroll", {"json": {"protocol": 1}}),
            ("post", "/api/node/heartbeat", {"json": {"protocol": 1}}),
            ("get", "/api/node/config", {}),
            ("post", "/api/node/report",
             {"json": {"protocol": 1, "hash": "x", "ok": True,
                       "stage": "applied"}}),
        ]:
            response = getattr(self.client, method)(
                path, headers=self._auth(token_a, self.node_b), **kwargs)
            self.assertEqual(response.status_code, 401, path)


if __name__ == "__main__":
    unittest.main()
