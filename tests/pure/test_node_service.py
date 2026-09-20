"""Pure rules for node rows: the reported-address pick and the out shape.

Why pure: reported_address_for is a total function over strings and
_to_out projects a row dict — neither touches a database, so they unit
test in milliseconds under the same interpreter the workerd tier uses.
"""

import unittest

from services.node_service import _to_out, reported_address_for


class ReportedAddressFor(unittest.TestCase):
    """The pick order and the guard rails around a storeable value."""

    def test_agent_report_wins_over_the_edge_observation(self):
        self.assertEqual(
            reported_address_for("203.0.113.7", "198.51.100.9"), "203.0.113.7")

    def test_edge_header_is_the_fallback(self):
        """A missing or blank agent report falls back to CF-Connecting-IP."""
        self.assertEqual(
            reported_address_for(None, "198.51.100.9"), "198.51.100.9")
        self.assertEqual(
            reported_address_for("   ", "198.51.100.9"), "198.51.100.9")

    def test_no_usable_candidate_means_none(self):
        self.assertIsNone(reported_address_for(None, None))
        self.assertIsNone(reported_address_for("", "   "))

    def test_values_are_stripped(self):
        self.assertEqual(
            reported_address_for(" 203.0.113.7 ", None), "203.0.113.7")

    def test_oversized_reports_are_rejected(self):
        self.assertIsNone(reported_address_for("a" * 256, None))

    def test_whitespace_inside_is_rejected(self):
        """A value with embedded whitespace is garbage, not an address."""
        self.assertIsNone(reported_address_for("203.0.113.7\n198.51.100.9", None))


class ToOut(unittest.TestCase):
    """The node row projection, including the new reported address."""

    def _row(self, config_json=None, reported=None) -> dict:
        return {
            "id": "tokyo01",
            "label": "Tokyo 01",
            "address": "funky.example.com",
            "reported_address": reported,
            "created_at": 1,
            "config_json": config_json,
        }

    def test_projects_reported_address_and_has_config(self):
        out = _to_out(self._row(config_json={"inbounds": []}, reported="203.0.113.7"))
        self.assertEqual(out["reported_address"], "203.0.113.7")
        self.assertTrue(out["has_config"])

    def test_none_report_and_none_config(self):
        out = _to_out(self._row())
        self.assertIsNone(out["reported_address"])
        self.assertFalse(out["has_config"])


if __name__ == "__main__":
    unittest.main()
