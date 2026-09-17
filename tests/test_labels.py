"""Tests for readable labels used by generated links.

Why this file exists: machine-readable names must stay qualified while the
admin and end user see stable display text. These tests pin tag
prettification and the standard three-part link label.
"""

import unittest

from services import labels


class TestPrettyTag(unittest.TestCase):
    """Local tags become readable without storing display names."""

    def test_common_tags(self):
        self.assertEqual(labels.pretty_tag("reality"), "REALITY")
        self.assertEqual(labels.pretty_tag("xhttp"), "XHTTP")
        self.assertEqual(labels.pretty_tag("niigata"), "Niigata")
        self.assertEqual(labels.pretty_tag("reality_in"), "REALITY IN")

    def test_invalid_input_has_no_display_name(self):
        self.assertEqual(labels.pretty_tag(None), "")
        self.assertEqual(labels.pretty_tag(""), "")


class TestLinkLabel(unittest.TestCase):
    """Generated links use the fleet-standard readable order."""

    def test_node_subject_exit_order(self):
        self.assertEqual(
            labels.link_label("Tokyo 01", "REALITY", "Niigata"),
            "Tokyo 01 · REALITY → Niigata",
        )


if __name__ == "__main__":
    unittest.main()
