"""The fail-closed route-group guard, over a real plane.

WHY HTTP: the middleware must 404 everything outside the four groups on
the app that actually serves. The pure `is_allowed_path` predicate lives
in tests/pure/test_route_groups.py. The old "registered-but-forbidden
route" case is gone: routes cannot be injected into a running Worker —
the predicate now carries that logic alone.
"""

import unittest

from tests.workerd.harness import client


class TestGuardMiddleware(unittest.TestCase):
    """The middleware, through the real plane."""

    def test_known_good_route_reaches_its_handler(self):
        response = client().get("/api/health")

        self.assertEqual(response.status_code, 200)

    def test_docs_and_legacy_paths_are_blocked(self):
        """Disabled docs and the archived panel's paths 404, never leak."""
        for path in ("/docs", "/openapi.json", "/api/users"):
            response = client().get(path)

            self.assertEqual(response.status_code, 404, path)

    def test_outside_groups_is_unreachable(self):
        """Anything outside the four groups 404s, never leaks.

        Why `/` is not here: the static-assets binding serves the SPA at
        the root before the Worker runs, so it is an assets fact, not a
        guard fact. The pure predicate still pins `/` as blocked.
        """
        for path in ("/api", "/api/admin", "/api/node", "/sub",
                     "/api/adminx", "/api/health/extra"):
            response = client().get(path)

            self.assertEqual(response.status_code, 404, path)


if __name__ == "__main__":
    unittest.main()
