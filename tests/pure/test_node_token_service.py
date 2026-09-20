"""Tests for node bearer-token minting, hashing, and verification.

Why unittest without a db: these are the pure custody rules — entropy at
request time, hash at rest, constant-time compare — and they must hold
regardless of which backend stores the hash.
"""

import unittest

from services import node_token_service


class TestMintToken(unittest.TestCase):
    """Tokens are high-entropy random, safe for agent.toml."""

    def test_mints_are_unique_urlsafe_text(self):
        first = node_token_service.mint_token()
        second = node_token_service.mint_token()

        self.assertIsInstance(first, str)
        self.assertNotEqual(first, second)
        self.assertGreaterEqual(len(first), 43)

    def test_hash_is_a_stable_64_hex_digest(self):
        token = node_token_service.mint_token()

        digest = node_token_service.token_hash(token)

        self.assertEqual(len(digest), 64)
        self.assertEqual(digest, node_token_service.token_hash(token))
        int(digest, 16)


class TestVerifyToken(unittest.TestCase):
    """Only the presented token matching the stored hash verifies."""

    def test_roundtrip_verifies(self):
        token = node_token_service.mint_token()
        stored = node_token_service.token_hash(token)

        self.assertTrue(node_token_service.verify_token(stored, token))

    def test_wrong_token_fails(self):
        stored = node_token_service.token_hash(node_token_service.mint_token())

        self.assertFalse(node_token_service.verify_token(stored, "wrong"))

    def test_missing_hash_never_verifies(self):
        for missing in (None, ""):
            self.assertFalse(
                node_token_service.verify_token(
                    missing, node_token_service.mint_token()))

    def test_empty_presentation_fails(self):
        stored = node_token_service.token_hash(node_token_service.mint_token())

        self.assertFalse(node_token_service.verify_token(stored, ""))


if __name__ == "__main__":
    unittest.main()
