"""Tests for the PROTOCOL.md v1 pull contract over HTTP.

Why TestClient: authentication, status codes, and the heartbeat → config
→ report convergence loop are the cross-repo contract — exactly what an
HTTP test pins. The fake-agent flow here (enroll, poll, fetch, apply,
report) is the same loop the Lesserv-Agent repo runs for real; the plane
cannot tell them apart.
"""

import asyncio
import unittest

from fastapi.testclient import TestClient

import db
from services import node_state_service
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


class NodeProtocolApi(unittest.TestCase):
    """The /api/node/* surface over a throwaway backend."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)
        self.client = TestClient(make_test_app(self.conn))

    def _make_node(self, node_id="tokyo01", config=None):
        """Create a node via the API; optionally paste its config."""
        response = self.client.post("/api/admin/nodes", json={
            "id": node_id, "label": "Node", "address": "funky.example.com",
        })
        assert response.status_code == 201, response.text
        if config is not None:
            put = self.client.put(
                f"/api/admin/nodes/{node_id}/config", json=config)
            assert put.status_code == 200, put.text

    def _mint(self, node_id="tokyo01"):
        """Mint a token via the API and return the plaintext."""
        response = self.client.post(f"/api/admin/nodes/{node_id}/token")
        assert response.status_code == 201, response.text
        body = response.json()
        self.assertEqual(body["node_id"], node_id)
        self.assertTrue(body["token"])
        return body["token"]

    def _auth(self, token, node_id="tokyo01"):
        """Headers one node sends on every request."""
        return {
            "Authorization": f"Bearer {token}",
            "X-Lesserv-Node": node_id,
        }

    def _node_row(self, node_id="tokyo01"):
        """Read one node row straight from the throwaway db."""
        return asyncio.run(db.get_node(self.conn, node_id))

    def test_mint_404_for_unknown_node(self):
        self.assertEqual(
            self.client.post("/api/admin/nodes/ghost/token").status_code, 404)

    def test_mint_rotates_and_kills_the_old_token(self):
        self._make_node()
        first = self._mint()
        headers = self._auth(first)

        self.assertEqual(
            self.client.post("/api/node/enroll", headers=headers,
                             json={"protocol": 1}).status_code, 200)
        second = self._mint()

        self.assertNotEqual(first, second)
        self.assertEqual(
            self.client.post("/api/node/enroll", headers=headers,
                             json={"protocol": 1}).status_code, 401)
        self.assertEqual(
            self.client.post("/api/node/enroll", headers=self._auth(second),
                             json={"protocol": 1}).status_code, 200)

    def test_enroll_rejects_bad_credentials(self):
        self._make_node()
        token = self._mint()

        cases = [
            ({}, 401, "no headers at all"),
            ({"Authorization": f"Bearer {token}"}, 401, "no node header"),
            ({"X-Lesserv-Node": "tokyo01"}, 401, "no bearer token"),
            (self._auth("wrong"), 401, "wrong token"),
            (self._auth(token, "ghost"), 401, "unknown node id"),
        ]
        for headers, status, label in cases:
            response = self.client.post(
                "/api/node/enroll", headers=headers, json={"protocol": 1})
            self.assertEqual(response.status_code, status, label)

    def test_node_cannot_read_another_node(self):
        """The one invariant that deserves an explicit test (PROTOCOL.md)."""
        self._make_node("tokyo01", config=_config())
        self._make_node("toyama01", config=_config())
        token_a = self._mint("tokyo01")

        for method, path, kwargs in [
            ("post", "/api/node/enroll", {"json": {"protocol": 1}}),
            ("post", "/api/node/heartbeat",
             {"json": {"protocol": 1}}),
            ("get", "/api/node/config", {}),
            ("post", "/api/node/report",
             {"json": {"protocol": 1, "hash": "x", "ok": True,
                       "stage": "applied"}}),
            ("post", "/api/node/stats",
             {"json": {"protocol": 1, "boot_id": "b", "counters": {}}}),
        ]:
            response = getattr(self.client, method)(
                path, headers=self._auth(token_a, "toyama01"), **kwargs)
            self.assertEqual(response.status_code, 401, path)

    def test_enroll_returns_metadata_and_desired_hash(self):
        self._make_node(config=_config())
        token = self._mint()

        first = self.client.post("/api/node/enroll", headers=self._auth(token),
                                 json={"protocol": 1,
                                       "agent_version": "0.1.0",
                                       "xray_version": "25.1.1"})

        self.assertEqual(first.status_code, 200)
        body = first.json()
        self.assertEqual(body["state"], "active")
        self.assertEqual(body["id"], "tokyo01")
        self.assertTrue(body["desired_hash"])
        second = self.client.post(
            "/api/node/enroll", headers=self._auth(token),
            json={"protocol": 1})
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["desired_hash"], body["desired_hash"])
        row = self._node_row()
        self.assertEqual(row["agent_version"], "0.1.0")
        self.assertEqual(row["xray_version"], "25.1.1")
        self.assertIsNotNone(row["last_seen"])

    def test_enroll_without_config_has_null_desired_hash(self):
        self._make_node()
        token = self._mint()

        response = self.client.post(
            "/api/node/enroll", headers=self._auth(token),
            json={"protocol": 1})

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["desired_hash"])

    def test_unknown_protocol_is_an_explicit_400(self):
        self._make_node()
        token = self._mint()
        headers = self._auth(token)

        for path, kwargs in [
            ("/api/node/enroll", {"json": {"protocol": 999}}),
            ("/api/node/heartbeat", {"json": {"protocol": 999}}),
            ("/api/node/report", {"json": {"protocol": 999, "hash": "x",
                                           "ok": True, "stage": "applied"}}),
            ("/api/node/stats", {"json": {"protocol": 999, "boot_id": "b",
                                          "counters": {}}}),
        ]:
            response = self.client.post(path, headers=headers, **kwargs)
            self.assertEqual(response.status_code, 400, path)
            self.assertIn("999", response.json()["detail"])

    def test_heartbeat_returns_desired_hash_and_empty_actions(self):
        self._make_node(config=_config())
        token = self._mint()
        headers = self._auth(token)

        response = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1, "applied_hash": None,
                  "xray_running": False})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["desired_hash"])
        self.assertEqual(response.json()["actions"], [])

    def test_user_edit_flips_the_desired_hash_without_manual_action(self):
        """Content-hash convergence: no fan-out, just a new render."""
        self._make_node(config=_config())
        token = self._mint()
        headers = self._auth(token)
        before = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1}).json()["desired_hash"]

        created = self.client.post("/api/admin/users", json={
            "username": "alice",
            "access": {"tokyo01": {"allowed_inbounds": ["reality"],
                                  "allowed_outbounds": ["niigata"]}},
        })
        self.assertEqual(created.status_code, 201)
        after = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1}).json()["desired_hash"]

        self.assertNotEqual(before, after)

    def test_repeated_identical_heartbeat_skips_the_write(self):
        """Heartbeats are cheap: no news means no UPDATE."""
        self._make_node(config=_config())
        token = self._mint()
        headers = self._auth(token)
        payload = {"protocol": 1, "applied_hash": "abc",
                   "xray_running": True}
        self.client.post("/api/node/heartbeat", headers=headers,
                         json=payload)
        before = self._node_row()

        self.client.post("/api/node/heartbeat", headers=headers,
                         json=payload)
        after = self._node_row()

        self.assertEqual(before["last_seen"], after["last_seen"])
        self.assertEqual(after["applied_hash"], "abc")

    def test_config_returns_exact_render_and_honors_hash_guard(self):
        self._make_node(config=_config())
        token = self._mint()
        headers = self._auth(token)
        wanted = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1}).json()["desired_hash"]

        full = self.client.get("/api/node/config", headers=headers)

        self.assertEqual(full.status_code, 200)
        self.assertEqual(full.json()["hash"], wanted)
        self.assertIn("inbounds", full.json()["config"])
        self.assertEqual(full.headers["Cache-Control"], "no-store")
        current = self.client.get("/api/node/config", headers=headers,
                                  params={"hash": wanted})
        self.assertEqual(current.status_code, 200)
        self.assertEqual(current.json()["hash"], wanted)
        stale = self.client.get("/api/node/config", headers=headers,
                                params={"hash": "stale"})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["desired_hash"], wanted)

    def test_config_404_when_nothing_renderable(self):
        self._make_node()
        token = self._mint()

        response = self.client.get("/api/node/config",
                                   headers=self._auth(token))

        self.assertEqual(response.status_code, 404)

    def test_report_success_adopts_hash_and_clears_error(self):
        self._make_node(config=_config())
        token = self._mint()
        headers = self._auth(token)
        wanted = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1}).json()["desired_hash"]

        response = self.client.post(
            "/api/node/report", headers=headers,
            json={"protocol": 1, "hash": wanted, "ok": True,
                  "stage": "applied"})

        self.assertEqual(response.status_code, 200)
        row = self._node_row()
        self.assertEqual(row["applied_hash"], wanted)
        self.assertIsNone(row["last_error"])
        self.assertEqual(row["health"], "ok")

    def test_report_failure_keeps_hash_and_records_stage(self):
        """A failed apply rolled back: drift stays visible, cause stored."""
        self._make_node(config=_config())
        token = self._mint()
        headers = self._auth(token)
        self.client.post("/api/node/report", headers=headers,
                         json={"protocol": 1, "hash": "good", "ok": True,
                               "stage": "applied"})

        response = self.client.post(
            "/api/node/report", headers=headers,
            json={"protocol": 1, "hash": "bad", "ok": False,
                  "stage": "started", "error": "bind: address in use"})

        self.assertEqual(response.status_code, 200)
        row = self._node_row()
        self.assertEqual(row["applied_hash"], "good")
        self.assertEqual(row["last_error"], "bind: address in use")
        self.assertEqual(row["health"], "error:started")

    def test_report_rejects_unknown_stage(self):
        self._make_node()
        token = self._mint()

        response = self.client.post(
            "/api/node/report", headers=self._auth(token),
            json={"protocol": 1, "hash": "x", "ok": True, "stage": "nope"})

        self.assertEqual(response.status_code, 422)

    def test_duplicate_report_is_safe(self):
        self._make_node(config=_config())
        token = self._mint()
        headers = self._auth(token)
        payload = {"protocol": 1, "hash": "abc", "ok": True,
                   "stage": "applied"}

        self.client.post("/api/node/report", headers=headers, json=payload)
        before = self._node_row()
        self.client.post("/api/node/report", headers=headers, json=payload)
        after = self._node_row()

        self.assertEqual(before["applied_hash"], after["applied_hash"])

    def test_stats_accepts_counters_without_storing(self):
        self._make_node()
        token = self._mint()

        response = self.client.post(
            "/api/node/stats", headers=self._auth(token),
            json={"protocol": 1, "boot_id": "b3f1",
                  "counters": {
                      "user>>>alice@tokyo01-niigata>>>traffic>>>uplink": 10,
                      "user>>>alice@tokyo01-niigata>>>traffic>>>downlink": 20,
                  }})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"accepted": 2})

    def test_stats_rejects_bad_counters(self):
        self._make_node()
        token = self._mint()
        headers = self._auth(token)

        for counters in ({"a": -1}, {"a": "many"}, {"a": True}):
            response = self.client.post(
                "/api/node/stats", headers=headers,
                json={"protocol": 1, "boot_id": "b", "counters": counters})
            self.assertEqual(response.status_code, 422, repr(counters))

    def test_full_convergence_loop(self):
        """Fake agent: enroll → poll → fetch → report → in sync."""
        self._make_node(config=_config())
        token = self._mint()
        headers = self._auth(token)
        self.client.post("/api/admin/users", json={
            "username": "alice",
            "access": {"tokyo01": {"allowed_inbounds": ["reality"],
                                  "allowed_outbounds": ["niigata"]}},
        })

        self.client.post("/api/node/enroll", headers=headers,
                         json={"protocol": 1})
        wanted = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1, "applied_hash": None}).json()["desired_hash"]
        fetched = self.client.get(
            "/api/node/config", headers=headers,
            params={"hash": wanted}).json()
        self.assertEqual(fetched["hash"], wanted)
        self.client.post("/api/node/report", headers=headers,
                         json={"protocol": 1, "hash": wanted, "ok": True,
                               "stage": "applied"})
        settled = self.client.post(
            "/api/node/heartbeat", headers=headers,
            json={"protocol": 1,
                  "applied_hash": wanted}).json()["desired_hash"]

        self.assertEqual(settled, wanted)
        self.assertEqual(self._node_row()["applied_hash"], wanted)


class TestShouldTouch(unittest.TestCase):
    """The heartbeat cheap-write rule, without a database."""

    def _node(self, **overrides):
        """A stored row with boring defaults."""
        row = {
            "last_seen": 1000, "health": "ok", "agent_version": "0.1.0",
            "xray_version": "25.1.1", "last_error": None,
            "applied_hash": "abc",
        }
        row.update(overrides)
        return row

    def _values(self, **overrides):
        """Desired values identical to the stored row by default."""
        values = {
            "last_seen": 1000, "health": "ok", "agent_version": "0.1.0",
            "xray_version": "25.1.1", "last_error": None,
            "applied_hash": "abc",
        }
        values.update(overrides)
        return values

    def test_first_contact_always_writes(self):
        self.assertTrue(node_state_service.should_touch(
            self._node(last_seen=None), self._values(), 1000))

    def test_stale_liveness_writes(self):
        self.assertTrue(node_state_service.should_touch(
            self._node(last_seen=1000), self._values(), 1061))

    def test_fresh_identical_heartbeat_skips(self):
        self.assertFalse(node_state_service.should_touch(
            self._node(last_seen=1000), self._values(), 1059))

    def test_changed_fact_writes_even_when_fresh(self):
        self.assertTrue(node_state_service.should_touch(
            self._node(last_seen=1000),
            self._values(applied_hash="def"), 1001))


class TestProtocolFreeze(unittest.TestCase):
    """PROTOCOL.md is frozen at protocol 1 for the deployed plane (M4).

    Why a pin and not a docstring: both repos implement this number, and
    the agent's zero-code-change proof against Workers depends on it not
    drifting silently. Bumping it means editing this test, the agent, and
    PROTOCOL.md together.
    """

    def test_served_protocol_version_is_one(self):
        import routers.node

        self.assertEqual(routers.node.PROTOCOL_VERSION, 1)


if __name__ == "__main__":
    unittest.main()
