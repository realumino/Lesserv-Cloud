"""Tests for node qualification: local tags become node-scoped names.

Why this file exists: M2's central guarantee is that stored state stays
local while rendered and linked artifacts are qualified. These tests pin
every rewrite, idempotency, BLOCK exemption, copy semantics, and paste-time
validation before the renderer consumes the qualifier.
"""

import unittest

from services import qualify_service


def _config():
    """An authored config exercising tags and every rewritten reference."""
    return {
        "inbounds": [
            {"tag": "reality", "protocol": "vless"},
            {"tag": "xhttp", "protocol": "vless"},
        ],
        "outbounds": [
            {"tag": "niigata", "protocol": "freedom"},
            {"tag": "BLOCK", "protocol": "blackhole"},
        ],
        "routing": {
            "rules": [
                {"outboundTag": "niigata"},
                {"outboundTag": "BLOCK"},
                {"inboundTag": ["xhttp", "unknown"]},
                {"user": ["regexp:.*@niigata$", "alice@niigata"]},
                {"user": ["regexp:.*@unknown$", "other"]},
                {"domain": ["example.com"], "outboundTag": "unknown"},
            ]
        },
    }


class TestTagHelpers(unittest.TestCase):
    """Inbound suffixes, outbound prefixes, BLOCK, and idempotency."""

    def test_inbound_suffix_and_idempotency(self):
        self.assertEqual(
            qualify_service.qualified_inbound_tag("reality", "tokyo01"),
            "reality-tokyo01",
        )
        self.assertEqual(
            qualify_service.qualified_inbound_tag("reality-tokyo01", "tokyo01"),
            "reality-tokyo01",
        )

    def test_outbound_prefix_block_and_idempotency(self):
        self.assertEqual(
            qualify_service.qualified_outbound_tag("niigata", "tokyo01"),
            "tokyo01-niigata",
        )
        self.assertEqual(
            qualify_service.qualified_outbound_tag("tokyo01-niigata", "tokyo01"),
            "tokyo01-niigata",
        )
        self.assertEqual(
            qualify_service.qualified_outbound_tag("BLOCK", "tokyo01"), "BLOCK"
        )

    def test_blank_or_missing_tags_are_preserved(self):
        self.assertEqual(qualify_service.qualified_inbound_tag("", "tokyo01"), "")
        self.assertIsNone(qualify_service.qualified_outbound_tag(None, "tokyo01"))


class TestQualifyConfig(unittest.TestCase):
    """Authored configs are copied and every known reference is rewritten."""

    def test_tags_and_routing_references_are_qualified(self):
        qualified = qualify_service.qualify_config(_config(), "tokyo01")

        self.assertEqual(
            [inbound["tag"] for inbound in qualified["inbounds"]],
            ["reality-tokyo01", "xhttp-tokyo01"],
        )
        self.assertEqual(
            [outbound["tag"] for outbound in qualified["outbounds"]],
            ["tokyo01-niigata", "BLOCK"],
        )
        self.assertEqual(
            qualified["routing"]["rules"],
            [
                {"outboundTag": "tokyo01-niigata"},
                {"outboundTag": "BLOCK"},
                {"inboundTag": ["xhttp-tokyo01", "unknown"]},
                {
                    "user": [
                        "regexp:.*@tokyo01-niigata$",
                        "alice@tokyo01-niigata",
                    ]
                },
                {"user": ["regexp:.*@unknown$", "other"]},
                {"domain": ["example.com"], "outboundTag": "unknown"},
            ],
        )

    def test_input_is_not_mutated_and_qualification_is_idempotent(self):
        source = _config()
        once = qualify_service.qualify_config(source, "tokyo01")

        self.assertEqual(source, _config())
        self.assertEqual(
            qualify_service.qualify_config(once, "tokyo01"), once
        )


class TestQualifyUsersKeysProfiles(unittest.TestCase):
    """Access rows, uuid keys, stored keys, and profiles qualify together."""

    def _projected_user(self):
        return {
            "username": "alice",
            "status": "active",
            "allowed_inbounds": ["reality", ""],
            "allowed_outbounds": ["niigata", "BLOCK"],
            "uuids": {"alice@niigata": "u1", "alice@BLOCK": "u2"},
        }

    def _profiles(self):
        return [
            {
                "id": "b",
                "inbound_tag": "xhttp",
                "label": "B",
                "overrides": {"port": 443},
            },
            {"id": "a", "inbound_tag": "xhttp", "label": "A", "overrides": {}},
        ]

    def test_users(self):
        qualified = qualify_service.qualify_users(
            [self._projected_user()], "tokyo01"
        )

        self.assertEqual(qualified, [{
            "username": "alice",
            "status": "active",
            "allowed_inbounds": ["reality-tokyo01", ""],
            "allowed_outbounds": ["tokyo01-niigata", "BLOCK"],
            "uuids": {"alice@tokyo01-niigata": "u1", "alice@BLOCK": "u2"},
        }])

    def test_keys_and_profiles(self):
        qualified_keys = qualify_service.qualify_keys({"reality": "k"}, "tokyo01")
        grouped = qualify_service.qualify_profiles(self._profiles(), "tokyo01")

        self.assertEqual(qualified_keys, {"reality-tokyo01": "k"})
        self.assertEqual(
            [profile["id"] for profile in grouped["xhttp-tokyo01"]], ["a", "b"]
        )

    def test_qualifications_are_idempotent(self):
        users = qualify_service.qualify_users([self._projected_user()], "tokyo01")
        keys = qualify_service.qualify_keys({"reality": "k"}, "tokyo01")

        self.assertEqual(qualify_service.qualify_users(users, "tokyo01"), users)
        self.assertEqual(qualify_service.qualify_keys(keys, "tokyo01"), keys)


class TestLocalTagErrors(unittest.TestCase):
    """Paste-time validation catches only names that would double-qualify."""

    def test_valid_local_names_have_no_errors(self):
        self.assertEqual(qualify_service.local_tag_errors(_config(), "tokyo01"), [])

    def test_blank_and_prequalified_tags_are_reported(self):
        config = {
            "inbounds": [{"tag": "reality-tokyo01"}, {"tag": ""}],
            "outbounds": [{"tag": "tokyo01-niigata"}, {"tag": "BLOCK"}],
        }

        errors = qualify_service.local_tag_errors(config, "toyama01")

        # A blank tag is invalid everywhere, but names qualified for another
        # node are local names here.
        self.assertEqual(errors, ["inbound 1 has no tag"])
        errors = qualify_service.local_tag_errors(config, "tokyo01")

        self.assertEqual(len(errors), 3)
        self.assertTrue(any("reality-tokyo01" in error for error in errors))
        self.assertTrue(any("tokyo01-niigata" in error for error in errors))
        self.assertTrue(any("has no tag" in error for error in errors))

    def test_non_object_config_has_no_tag_errors(self):
        self.assertEqual(
            qualify_service.local_tag_errors(["inbounds"], "tokyo01"), []
        )


if __name__ == "__main__":
    unittest.main()
