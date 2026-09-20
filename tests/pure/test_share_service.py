"""Tests for share link generation.

Run:
    python -m unittest tests.test_share_service -v
"""

import unittest
from unittest import mock
from urllib.parse import quote

from services import share_service


class TestShareService(unittest.TestCase):
    """Build VLESS URIs from users and the Xray config."""

    def _config(self):
        """Return a config that exercises raw/reality, xhttp, and ws."""
        return {
            "inbounds": [
                {
                    "tag": "REALITY_IN",
                    "protocol": "vless",
                    "listen": "0.0.0.0",
                    "port": 443,
                    "settings": {"flow": "xtls-rprx-vision"},
                    "streamSettings": {
                        "network": "raw",
                        "security": "reality",
                        "realitySettings": {
                            "serverNames": ["apple.com"],
                            "privateKey": "sMS4KcvOCag9dZsYPa3sFfVLSn3IGNEI34B7ENhGBFE",
                            "shortIds": ["1234"],
                        },
                    },
                },
                {
                    "tag": "XHTTP_IN",
                    "protocol": "vless",
                    "listen": "203.0.113.5",
                    "port": 8080,
                    "streamSettings": {
                        "network": "xhttp",
                        "xhttpSettings": {
                            "path": "/xhttp-path",
                            "host": "xhttp.example.com",
                            "mode": "auto",
                        },
                    },
                },
                {
                    "tag": "WS_IN",
                    "protocol": "vless",
                    "listen": "::",
                    "port": 8443,
                    "streamSettings": {
                        "network": "ws",
                        "wsSettings": {
                            "path": "/ws-path",
                            "host": "ws.example.com",
                        },
                    },
                },
                {"tag": "HTTP_ONLY", "protocol": "http", "port": 80},
            ],
            "outbounds": [
                {"tag": "JAPAN", "protocol": "freedom"},
                {"tag": "HK", "protocol": "freedom"},
            ],
        }

    def _user(self, inbounds=None, outbounds=None):
        """Return a test user; default inbounds exclude the non-VLESS one."""
        allowed_outbounds = outbounds or ["JAPAN"]
        return {
            "username": "alice",
            "status": "active",
            "allowed_inbounds": inbounds or ["REALITY_IN", "XHTTP_IN", "WS_IN"],
            "allowed_outbounds": allowed_outbounds,
            "uuids": {
                f"alice@{outbound}": "11111111-1111-1111-1111-111111111111"
                for outbound in allowed_outbounds
            },
        }

    def test_raw_reality_link(self):
        """REALITY inbound produces a correctly ordered vless:// URI."""
        links, warnings = share_service.links_for_user(
            self._user(["REALITY_IN"]), self._config(), "example.com"
        )

        self.assertEqual(len(links), 1)
        reality = links[0]
        self.assertEqual(reality["outbound"], "JAPAN")
        self.assertIn("vless://11111111-", reality["uri"])
        self.assertIn("example.com:443", reality["uri"])
        self.assertIn("type=tcp", reality["uri"])
        self.assertIn("security=reality", reality["uri"])
        self.assertIn("sni=apple.com", reality["uri"])
        self.assertIn("pbk=w_OZ1uUriCcd12KatYIFBJulAFDGNp9V1wL_XiQBt08", reality["uri"])
        self.assertIn("sid=1234", reality["uri"])
        self.assertIn("fp=chrome", reality["uri"])
        self.assertIn("encryption=none", reality["uri"])
        self.assertIn("flow=xtls-rprx-vision", reality["uri"])
        self.assertEqual(warnings, [])

    def test_reality_keys_override_config_private_key(self):
        """pbk is derived from the panel's stored key, not the config's."""
        import base64

        from core.x25519 import derive_public_key

        # RFC 7748 §6.1 Alice's private key — a known-good stand-in
        alice_hex = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"
        alice_b64 = base64.urlsafe_b64encode(bytes.fromhex(alice_hex)).decode().rstrip("=")

        links, _ = share_service.links_for_user(
            self._user(["REALITY_IN"]), self._config(), "example.com",
            reality_keys={"REALITY_IN": alice_b64},
        )

        expected = derive_public_key(alice_b64)
        self.assertIn(f"pbk={expected}", links[0]["uri"])
        # differs from the config key's pbk -> the override really won
        self.assertNotIn("pbk=w_OZ1uUriCcd12KatYIFBJulAFDGNp9V1wL_XiQBt08", links[0]["uri"])

    def test_reality_keys_fall_back_to_config_value(self):
        """Tags absent from reality_keys use the config's own privateKey."""
        links, warnings = share_service.links_for_user(
            self._user(["REALITY_IN"]), self._config(), "example.com",
            reality_keys={"OTHER_TAG": "whatever"},
        )

        self.assertIn("pbk=w_OZ1uUriCcd12KatYIFBJulAFDGNp9V1wL_XiQBt08", links[0]["uri"])
        self.assertEqual(warnings, [])

    def test_xhttp_link(self):
        """XHTTP inbound uses address fallback, path, host, and mode."""
        links, warnings = share_service.links_for_user(
            self._user(["XHTTP_IN"]), self._config(), ""
        )

        self.assertEqual(len(links), 1)
        self.assertIn("203.0.113.5:8080", links[0]["uri"])
        self.assertIn("type=xhttp", links[0]["uri"])
        self.assertIn("path=%2Fxhttp-path", links[0]["uri"])
        self.assertIn("host=xhttp.example.com", links[0]["uri"])
        self.assertIn("mode=auto", links[0]["uri"])
        self.assertNotIn("flow=", links[0]["uri"])
        self.assertEqual(warnings, [])

    def test_non_vless_inbound_is_skipped(self):
        """HTTP inbound is skipped with a warning."""
        links, warnings = share_service.links_for_user(
            self._user(["REALITY_IN", "HTTP_ONLY"]),
            self._config(),
            "example.com",
        )
        tags = [link["inbound"] for link in links]

        self.assertEqual(tags, ["REALITY_IN"])
        self.assertIn("skipping non-vless inbound 'HTTP_ONLY'", warnings)

    def test_unknown_outbound_warns(self):
        """An allowed outbound not in the config is skipped."""
        user = self._user(["REALITY_IN"])
        user["allowed_outbounds"] = ["NOWHERE"]
        links, warnings = share_service.links_for_user(
            user, self._config(), "example.com"
        )

        self.assertEqual(links, [])
        self.assertIn("unknown outbound 'NOWHERE'", warnings)

    def test_disabled_user_generates_links_with_warning(self):
        """Disabled users still get links, but a warning is included."""
        user = self._user(["REALITY_IN"])
        user["status"] = "disabled"
        links, warnings = share_service.links_for_user(
            user, self._config(), "example.com"
        )

        self.assertTrue(links)
        self.assertIn("user alice is disabled", warnings)

    def test_wildcard_listen_ignored_when_no_configured_address(self):
        """0.0.0.0 and :: listens do not provide a usable address."""
        links, warnings = share_service.links_for_user(
            self._user(), self._config(), ""
        )
        tags = [link["inbound"] for link in links]

        self.assertEqual(tags, ["XHTTP_IN"])
        self.assertIn("no address for inbound 'REALITY_IN'", warnings)
        self.assertIn("no address for inbound 'WS_IN'", warnings)

    def test_profile_adds_one_variant_per_exit_without_changing_direct(self):
        user = self._user(
            ["REALITY_IN", "XHTTP_IN", "WS_IN"], ["HK", "JAPAN"]
        )
        profiles = {
            "XHTTP_IN": [{
                "id": "cdn",
                "label": "CDN",
                "overrides": {"address": "cdn.example.com", "port": 443},
            }]
        }

        links, warnings = share_service.links_for_user(
            user, self._config(), "example.com", profiles=profiles
        )

        # Three direct inbounds times two exits, plus the XHTTP profile
        # once for each of the two exits.
        self.assertEqual(len(links), 8)
        self.assertEqual(warnings, [])
        profile_links = [link for link in links if link["profile"] == "cdn"]
        self.assertEqual(len(profile_links), 2)
        self.assertIn("cdn.example.com:443", profile_links[0]["uri"])
        self.assertIsNone(links[0]["profile"])
        self.assertIsNone(links[0]["label"])
        self.assertIn("#alice%40", links[0]["uri"])

    def test_labels_name_direct_and_profile_variants(self):
        profiles = {
            "XHTTP_IN": [{
                "id": "cdn",
                "label": "CDN",
                "overrides": {"address": "cdn.example.com", "port": 443},
            }]
        }
        labels = {
            "XHTTP_IN": "XHTTP",
            "JAPAN": "Japan",
        }

        links, warnings = share_service.links_for_user(
            self._user(["XHTTP_IN"]), self._config(), "example.com",
            profiles=profiles, node_label="Tokyo 01", labels=labels,
        )

        self.assertEqual(warnings, [])
        self.assertEqual(
            [(link["profile"], link["label"]) for link in links],
            [
                (None, "Tokyo 01 · XHTTP → Japan"),
                ("cdn", "Tokyo 01 · CDN → Japan"),
            ],
        )
        self.assertTrue(
            links[1]["uri"].endswith("#" + quote(links[1]["label"], safe=""))
        )

    def test_profile_can_supply_an_address_the_direct_view_lacks(self):
        profiles = {
            "REALITY_IN": [{
                "id": "cdn",
                "label": "CDN",
                "overrides": {"address": "cdn.example.com", "port": 443},
            }]
        }

        links, warnings = share_service.links_for_user(
            self._user(["REALITY_IN"]), self._config(), "", profiles=profiles
        )

        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["profile"], "cdn")
        self.assertIn("cdn.example.com:443", links[0]["uri"])
        self.assertIn("no address for inbound 'REALITY_IN'", warnings)

    def test_has_usable_address(self):
        """Detect when at least one inbound has a real listen address."""
        self.assertTrue(
            share_service.has_usable_address(self._config(), "example.com")
        )
        # With no configured address, XHTTP_IN's real IP is still usable.
        self.assertTrue(share_service.has_usable_address(self._config(), ""))
        config = {"inbounds": [{"tag": "ONLY", "listen": "0.0.0.0"}]}
        self.assertFalse(share_service.has_usable_address(config, ""))
        self.assertTrue(
            share_service.has_usable_address(config, "", ["cdn.example.com"])
        )


# The archived file's TestShareRouter class (GET /api/users/{u}/links,
# calling endpoint functions with mocks) is replaced by node-scoped
# endpoint tests in tests/workerd/test_admin_users.py: the links endpoint
# now aggregates across nodes, so its status-code semantics live there.


if __name__ == "__main__":
    unittest.main()
