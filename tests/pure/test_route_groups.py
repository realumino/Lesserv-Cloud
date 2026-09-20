"""Tests for the fail-closed route-group predicate.

Pure function only: `is_allowed_path` decides group membership from a
path string, so it runs identically under any Python. The middleware
behavior it backs lives in tests/workerd/test_guard.py.
"""

import unittest

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


if __name__ == "__main__":
    unittest.main()
