"""Tests for config_service: turning users + config into a filled runtime config.

Run from the repo root:
    python -m unittest tests.test_config_service -v
"""

import unittest

from services import config_service


def _config():
    """A tiny stand-in for a real Xray config with one of each piece.

    Why so small: config_service must only touch routing.rules and VLESS
    clients; a small fixture makes the "everything else survives" checks
    readable.
    """
    return {
        "log": {"loglevel": "debug"},
        "routing": {"rules": [{"domain": ["example.com"], "outboundTag": "OUTBOUND"}]},
        "inbounds": [
            {
                "tag": "REALITY",
                "protocol": "vless",
                "port": 443,
                "settings": {"clients": [], "decryption": "none"},
            },
            {
                "tag": "XHTTP",
                "protocol": "vless",
                "listen": "sock",
                "settings": {"clients": [{}]},
            },
        ],
        "outbounds": [
            {"tag": "OUTBOUND", "protocol": "wireguard"},
            {"tag": "BLOCK", "protocol": "blackhole"},
        ],
    }


def _user(username, inbounds, outbounds, uuids, status="active"):
    """Build one user dict in the shape db.list_users returns."""
    return {
        "username": username,
        "status": status,
        "allowed_inbounds": inbounds,
        "allowed_outbounds": outbounds,
        "uuids": uuids,
    }


class TestBuildConfig(unittest.TestCase):
    def test_clients_and_rules_filled(self):
        users = [_user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"})]

        config, warnings = config_service.build_config(_config(), users)

        self.assertEqual(
            config["inbounds"][0]["settings"]["clients"],
            [{"id": "u1", "email": "alice@OUTBOUND"}],
        )
        self.assertEqual(
            config["routing"]["rules"],
            [
                {"domain": ["example.com"], "outboundTag": "OUTBOUND"},
                {"user": ["regexp:.*@OUTBOUND$"], "outboundTag": "OUTBOUND"},
            ],
        )
        self.assertEqual(warnings, [])

    def test_config_not_mutated(self):
        source = _config()
        users = [_user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"})]

        config_service.build_config(source, users)

        self.assertEqual(source, _config())

    def test_opaque_parts_preserved(self):
        source = _config()
        users = [_user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"})]

        config, _ = config_service.build_config(source, users)

        self.assertEqual(config["log"], source["log"])
        # outbound ORDER is panel-owned (BLOCK first), so compare as sets
        self.assertEqual(
            sorted(config["outbounds"], key=lambda o: o.get("tag", "")),
            sorted(source["outbounds"], key=lambda o: o.get("tag", "")),
        )
        self.assertEqual(config["inbounds"][0]["port"], 443)

    def test_unused_vless_inbound_gets_empty_clients(self):
        users = [_user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"})]

        config, _ = config_service.build_config(_config(), users)

        self.assertEqual(config["inbounds"][1]["settings"]["clients"], [])

    def test_disabled_user_excluded(self):
        users = [
            _user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"}),
            _user("bob", ["REALITY"], ["OUTBOUND"], {"bob@OUTBOUND": "u2"},
                  status="disabled"),
        ]

        config, _ = config_service.build_config(_config(), users)

        self.assertEqual(
            config["inbounds"][0]["settings"]["clients"],
            [{"id": "u1", "email": "alice@OUTBOUND"}],
        )

    def test_block_auto_injected_first_and_no_catch_all_rule(self):
        source = _config()
        source["outbounds"] = [{"tag": "OUTBOUND", "protocol": "wireguard"}]

        config, warnings = config_service.build_config(source, [])

        self.assertEqual(config["outbounds"][0]["tag"], "BLOCK")
        self.assertNotIn("no BLOCK", warnings)
        # generated rules exist even with zero users (one per outbound tag);
        # what matters here: no matcher-less catch-all rule anywhere
        for rule in config["routing"]["rules"]:
            matchers = [k for k in rule if k != "outboundTag"]
            self.assertTrue(matchers, "matcher-less rule: %r" % rule)

    def test_no_rule_lacks_a_matcher(self):
        source = _config()
        users = [_user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"})]

        config, _ = config_service.build_config(source, users)

        for rule in config["routing"]["rules"]:
            matchers = [k for k in rule if k != "outboundTag"]
            self.assertTrue(
                matchers, "matcher-less rule: %r (Xray rejects these)" % rule
            )

    def test_existing_block_moved_to_first(self):
        source = _config()  # outbounds: [OUTBOUND, BLOCK]

        config, _ = config_service.build_config(source, [])

        self.assertEqual(
            [o["tag"] for o in config["outbounds"]], ["BLOCK", "OUTBOUND"]
        )

    def test_customized_block_dict_is_preserved(self):
        source = _config()
        customized = {
            "tag": "BLOCK",
            "protocol": "blackhole",
            "settings": {"response": {"type": "http"}},
        }
        source["outbounds"] = [customized, {"tag": "OUTBOUND", "protocol": "wireguard"}]

        config, _ = config_service.build_config(source, [])

        self.assertEqual(config["outbounds"][0], customized)

    def test_missing_routing_is_auto_created(self):
        source = _config()
        del source["routing"]
        users = [_user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"})]

        config, warnings = config_service.build_config(source, users)

        self.assertIn("routing", config)
        self.assertGreater(len(config["routing"]["rules"]), 0)

    def test_user_rules_are_preserved_and_extended(self):
        source = _config()
        user_rule = {
            "user": ["regexp:.*@CUSTOM$"],
            "outboundTag": "OUTBOUND",
        }
        source["routing"]["rules"] = [user_rule]
        users = [_user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"})]

        config, _ = config_service.build_config(source, users)

        self.assertEqual(config["routing"]["rules"][0], user_rule)
        self.assertGreater(len(config["routing"]["rules"]), 1)

    def test_routing_other_keys_preserved(self):
        source = _config()
        source["routing"]["domainStrategy"] = "IPOnDemand"
        users = [_user("alice", ["REALITY"], ["OUTBOUND"], {"alice@OUTBOUND": "u1"})]

        config, _ = config_service.build_config(source, users)

        self.assertEqual(config["routing"]["domainStrategy"], "IPOnDemand")
        self.assertIn("rules", config["routing"])

    def test_outbound_tags_excludes_block(self):
        source = _config()

        tags = config_service.outbound_tags(source)

        self.assertNotIn("BLOCK", tags)
        self.assertIn("OUTBOUND", tags)


def _reality_config():
    """A config exercising the private-key fill: one REALITY, one plain."""
    return {
        "inbounds": [
            {
                "tag": "REALITY",
                "protocol": "vless",
                "settings": {"clients": []},
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {
                        "target": "example.com:443",
                        "privateKey": "operator-key",
                    },
                },
            },
            {"tag": "PLAIN", "protocol": "vless", "settings": {"clients": []}},
        ],
        "outbounds": [],
    }


class TestRealityKeys(unittest.TestCase):
    def test_reality_inbound_tags_found_by_settings_block(self):
        tags = config_service.reality_inbound_tags(_reality_config())

        self.assertEqual(tags, ["REALITY"])

    def test_reality_tag_without_stream_settings_is_ignored(self):
        config = {"inbounds": [{"tag": "BARE", "protocol": "vless"}], "outbounds": []}

        self.assertEqual(config_service.reality_inbound_tags(config), [])

    def test_apply_overwrites_user_key(self):
        runtime, _ = config_service.build_config(_reality_config(), [])

        warnings = config_service.apply_reality_keys(runtime, {"REALITY": "panel-key"})

        reality = runtime["inbounds"][0]["streamSettings"]["realitySettings"]
        self.assertEqual(reality["privateKey"], "panel-key")
        self.assertEqual(reality["target"], "example.com:443")  # rest preserved
        self.assertEqual(warnings, [])

    def test_apply_missing_key_warns_and_keeps_config_value(self):
        runtime, _ = config_service.build_config(_reality_config(), [])

        warnings = config_service.apply_reality_keys(runtime, {})

        self.assertEqual(
            runtime["inbounds"][0]["streamSettings"]["realitySettings"]["privateKey"],
            "operator-key",
        )
        self.assertEqual(len(warnings), 1)

    def test_apply_does_not_touch_callers_config(self):
        source = _reality_config()
        runtime, _ = config_service.build_config(source, [])

        config_service.apply_reality_keys(runtime, {"REALITY": "panel-key"})

        self.assertEqual(source, _reality_config())


if __name__ == "__main__":
    unittest.main()
