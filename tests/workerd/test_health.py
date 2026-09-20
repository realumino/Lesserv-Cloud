"""Health endpoint over a real plane.

WHY only this: TestStartup's lifespan test lost its subject with
src/local.py (migrations are wrangler's job now, and the harness applies
them before boot); the admin smoke moved into test_admin_nodes.py.
"""

import unittest

from tests.workerd.harness import client


class TestHealth(unittest.TestCase):
    """The route both the plane and agents must serve identically."""

    def test_health_is_ok(self):
        response = client().get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
