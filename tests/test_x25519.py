"""Tests for the pure-Python X25519 helper.

Run:
    python -m unittest tests.test_x25519 -v
"""

import base64
import unittest

from core.x25519 import (
    derive_public_key,
    generate_private_key,
    public_key_from_raw,
)


class TestX25519(unittest.TestCase):
    """Validate public-key derivation with RFC and cross-implementation vectors."""

    def _assert_base64url_equals_hex(self, actual_b64: str, expected_hex: str):
        """Compare a base64url public key with an RFC hex test vector."""
        expected_raw = bytes.fromhex(expected_hex)
        expected_b64 = base64.urlsafe_b64encode(expected_raw).decode().rstrip("=")
        self.assertEqual(actual_b64, expected_b64)

    def test_rfc_7748_alice_keypair(self):
        """RFC 7748 §6.1 Alice's private -> public key."""
        private_key = bytes.fromhex(
            "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"
        )
        expected_hex = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"

        self._assert_base64url_equals_hex(public_key_from_raw(private_key), expected_hex)

    def test_rfc_7748_bob_keypair(self):
        """RFC 7748 §6.1 Bob's private -> public key."""
        private_key = bytes.fromhex(
            "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb"
        )
        expected_hex = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"

        self._assert_base64url_equals_hex(public_key_from_raw(private_key), expected_hex)

    def test_config_private_key_yields_expected_public_key(self):
        """Cross-check with Node/OpenSSL for the project's config key."""
        private_key = "sMS4KcvOCag9dZsYPa3sFfVLSn3IGNEI34B7ENhGBFE"
        expected_public = "w_OZ1uUriCcd12KatYIFBJulAFDGNp9V1wL_XiQBt08"

        self.assertEqual(derive_public_key(private_key), expected_public)

    def test_standard_base64_with_padding_is_accepted(self):
        """Both URL-safe unpadded and standard padded forms work."""
        private_key = "sMS4KcvOCag9dZsYPa3sFfVLSn3IGNEI34B7ENhGBFE"
        standard = "sMS4KcvOCag9dZsYPa3sFfVLSn3IGNEI34B7ENhGBFE="

        from_urlsafe = derive_public_key(private_key)
        from_standard = derive_public_key(standard)

        self.assertEqual(from_standard, from_urlsafe)

    def test_empty_or_invalid_input_returns_none(self):
        """A missing/malformed key is not a hard error."""
        self.assertIsNone(derive_public_key(""))
        self.assertIsNone(derive_public_key("not-base64!!!"))
        self.assertIsNone(derive_public_key("aW52YWxpZA"))  # only 8 bytes


class TestGeneratePrivateKey(unittest.TestCase):
    """Generated keys must be valid Xray-format X25519 private keys."""

    def test_generated_key_is_32_bytes_base64url_unpadded(self):
        """The encoding matches what `xray x25519` prints."""
        key = generate_private_key()

        self.assertNotIn("=", key)
        self.assertNotIn("+", key)
        self.assertNotIn("/", key)
        self.assertEqual(len(base64.urlsafe_b64decode(key + "=" * (-len(key) % 4))), 32)

    def test_generated_key_is_clamped(self):
        """RFC 7748 clamping bits are set/cleared in the raw scalar."""
        key = generate_private_key()
        raw = base64.urlsafe_b64decode(key + "=" * (-len(key) % 4))

        self.assertEqual(raw[0] & 248, raw[0])
        self.assertEqual(raw[31] & 127, raw[31])
        self.assertEqual(raw[31] | 64, raw[31])

    def test_generated_key_derives_a_public_key(self):
        """A generated key round-trips through the derivation path."""
        public = derive_public_key(generate_private_key())

        self.assertIsNotNone(public)
        self.assertEqual(len(base64.urlsafe_b64decode(public + "=" * (-len(public) % 4))), 32)

    def test_generated_keys_are_unique(self):
        """Two generations must practically never collide."""
        self.assertNotEqual(generate_private_key(), generate_private_key())


if __name__ == "__main__":
    unittest.main()
