"""Tests for the fail-closed route-group guard.

Why this file exists: the guard is the in-app half of the trust boundary.
It must 404 everything outside the four groups — including a route that
someone registers at a wrong path later — and this file proves both the
pure predicate and the middleware behavior.
"""

import unittest

from fastapi import APIRouter
from fastapi.testclient import TestClient

import local
from main import create_app
from route_groups import is_allowed_path


class TestIsAllowedPath(unittest.TestCase):
    """The pure predicate: exactly the four groups, nothing else."""

    def test_allowed_paths(self):
        for path in (
            "/api/health",
            "/api/admin/nodes",
            "/api/admin/nodes/tokyo01/config",
            "/api/admin/users/alice/links",
            "/api/node/heartbeat",
            "/sub/sometoken",
        ):
            self.assertTrue(is_allowed_path(path), path)

    def test_blocked_paths(self):
        for path in (
            "", "/", "/docs", "/redoc", "/openapi.json",
            "/api", "/api/admin", "/api/node", "/sub",
            "/api/users", "/api/spike/self-check",
            "/api/adminx", "/api/health/extra",
        ):
            self.assertFalse(is_allowed_path(path), path)


class TestGuardMiddleware(unittest.TestCase):
    """The middleware, through the real app object."""

    def setUp(self):
        self.app = create_app()

    def test_known_good_route_reaches_its_handler(self):
        with TestClient(self.app) as client:
            response = client.get("/api/health")
        self.assertEqual(response.status_code, 200)

    def test_docs_and_legacy_paths_are_blocked(self):
        """Disabled docs and the archived panel's paths 404, never leak."""
        with TestClient(self.app) as client:
            for path in ("/docs", "/openapi.json", "/api/users"):
                response = client.get(path)
                self.assertEqual(response.status_code, 404, path)

    def test_route_outside_groups_is_unreachable_even_if_registered(self):
        """A route added outside the groups must stay dead — fail closed.

        Why this matters: the natural way to expose something by accident
        is registering it at the wrong prefix. The guard must beat the
        routing table. The route is added to (and removed from) the shared
        app, so the test proves the middleware, not an absent route.
        """
        router = APIRouter()

        @router.get("/api/secret")
        def secret():
            """A route that must never be reachable."""
            return {"secret": True}

        before = len(local.app.routes)
        local.app.include_router(router)

        def _trim():
            del local.app.routes[before:]

        self.addCleanup(_trim)
        with TestClient(local.app) as client:
            response = client.get("/api/secret")
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
