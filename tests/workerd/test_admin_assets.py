"""The built SPA is served at /admin with a deep-link fallback.

WHY this file exists: static assets are matched before the Worker, so only
this tier can prove the M4 serving arrangement still holds after the M5
rebuild. Two behaviors matter and are easy to break: a browser navigation
to a deep link must return the shell (the refreshable-URL claim), and a
non-navigation request to an unknown path must still fail closed rather
than being handed the shell.

WHY navigation headers are explicit: workerd's single-page-application
handling serves the root index only to navigation requests (browsers send
`Sec-Fetch-Mode: navigate`). A bare HTTP client is not a browser
navigation, so the tests say so rather than assuming it.
"""

import unittest

from tests.workerd.harness import client

_NAVIGATION = {
    "Accept": "text/html,application/xhtml+xml",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Site": "none",
}


class AdminAssets(unittest.TestCase):
    """The /admin static surface over a live plane."""

    def test_admin_root_serves_the_shell(self):
        response = client().get("/admin/")

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers["content-type"])
        self.assertIn("<!doctype", response.text.lower())

    def test_deep_link_serves_the_shell_to_a_navigation(self):
        """The M5 done-when: /admin/nodes/tokyo01/config is refreshable."""
        response = client().get(
            "/admin/nodes/tokyo01/config", headers=_NAVIGATION)

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers["content-type"])
        self.assertIn("<!doctype", response.text.lower())

    def test_unknown_non_navigation_path_fails_closed(self):
        """Only navigations get the shell; everything else 404s."""
        response = client().get("/admin/nodes/tokyo01/config")

        self.assertEqual(response.status_code, 404)
        self.assertIn("application/json", response.headers["content-type"])


if __name__ == "__main__":
    unittest.main()
