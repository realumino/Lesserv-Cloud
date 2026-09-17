"""Tests for the app object and the spike routes under the local runtime.

Why TestClient matters for M0: criterion (e) is that adding the dual-
runtime machinery did not break ordinary local testing. These tests boot
the same `app` workerd runs, with the SQLite backend attached, and assert
the same JSON the Worker runtime returned during the spike.
"""

import unittest

from fastapi.testclient import TestClient

import local


class TestHealth(unittest.TestCase):
    """The route both runtimes must serve identically."""

    def test_health_is_ok(self):
        with TestClient(local.app) as client:
            response = client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


class TestSelfCheck(unittest.TestCase):
    """The spike harness runs against the SQLite backend.

    Why not assert overall `ok`: the WebCrypto check is skipped outside
    workerd by design (criterion (d) is a Worker-runtime claim), so a
    passing local run has one skipped check and three passes. The env
    opt-in also doubles as the proof that the spike gate fails closed.
    """

    def setUp(self):
        import os
        from unittest import mock

        self.env = mock.patch.dict(os.environ, {"LESSERV_SPIKE": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_pure_checks_pass(self):
        with TestClient(local.app) as client:
            body = client.get("/api/spike/self-check").json()
        self.assertTrue(body["checks"]["x25519_rfc7748"]["ok"])
        self.assertTrue(body["checks"]["allocator"]["ok"])
        self.assertTrue(body["checks"]["db_roundtrip"]["ok"])

    def test_crypto_check_is_skipped_locally(self):
        with TestClient(local.app) as client:
            body = client.get("/api/spike/self-check").json()
        self.assertFalse(body["checks"]["aes_gcm_d1_roundtrip"]["ok"])
        self.assertIn("skipped", body["checks"]["aes_gcm_d1_roundtrip"]["failures"][0])

    def test_spike_route_disabled_without_opt_in(self):
        """Fail-closed: without LESSERV_SPIKE the diagnostics route 404s."""
        import os
        from unittest import mock

        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("LESSERV_SPIKE", None)
            with TestClient(local.app) as client:
                response = client.get("/api/spike/self-check")
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
