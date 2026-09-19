"""Tests for the key cipher: sealing, unsealing, and the runtime dispatch.

Why the dispatch is tested under CPython: the two branches that matter
locally are the plaintext fallback (no `workers` module) and the
loud failure on ciphertext without a secret. The actual AES-GCM
round-trip only exists inside workerd, so it is proven by the fake-cipher
seam here and re-proven live under `pywrangler dev` (docs/DEPLOY.md).
"""

import base64
import unittest

from services import key_cipher


class TestRuntimeDispatch(unittest.IsolatedAsyncioTestCase):
    """No workerd, no secret, no cipher — plaintext in, plaintext out."""

    def test_no_secret_under_cpython(self):
        """The `workers` import fails outside workerd; None means plaintext."""
        self.assertIsNone(key_cipher._secret_bytes())

    async def test_seal_without_secret_is_identity(self):
        key = "k" * 43

        self.assertEqual(await key_cipher.seal(key), key)

    async def test_unseal_without_secret_returns_plaintext(self):
        key = "k" * 43

        self.assertEqual(await key_cipher.unseal(key), key)

    async def test_unseal_ciphertext_without_secret_raises(self):
        """A v1 row with no cipher configured must fail loudly, never leak."""
        with self.assertRaises(RuntimeError):
            await key_cipher.unseal("v1:not-really-encrypted")


class TestSealedRoundTrip(unittest.IsolatedAsyncioTestCase):
    """The real crypto seam, exercised with a stand-in encrypt/decrypt pair.

    Why a stand-in: crypto.encrypt/decrypt need WebCrypto (workerd only).
    The swap proves the service-layer contract — storage receives what
    seal returned and key_map hands back the original key — without
    pretending to test WebCrypto itself.
    """

    def setUp(self):
        from services import key_cipher

        self._cipher = key_cipher
        self._real_secret = key_cipher._secret_bytes
        self._crypto = __import__("crypto")
        self._real_encrypt = self._crypto.encrypt
        self._real_decrypt = self._crypto.decrypt
        self.addCleanup(self._restore)

    def _restore(self):
        self._cipher._secret_bytes = self._real_secret
        self._crypto.encrypt = self._real_encrypt
        self._crypto.decrypt = self._real_decrypt

    def _install_fake_cipher(self, secret=b"x" * 32):
        """Wire a reversible fake into crypto.encrypt/decrypt for one test."""
        import base64

        self._cipher._secret_bytes = lambda: secret

        async def fake_encrypt(key_bytes, plaintext):
            self.assertEqual(key_bytes, secret)
            return "v1:fake:" + base64.b64encode(plaintext).decode()

        async def fake_decrypt(key_bytes, stored):
            self.assertEqual(key_bytes, secret)
            self.assertTrue(stored.startswith("v1:fake:"))
            return base64.b64decode(stored.split(":", 2)[2])

        self._crypto.encrypt = fake_encrypt
        self._crypto.decrypt = fake_decrypt
    async def test_seal_writes_v1_ciphertext_and_unseal_recovers(self):
        from services import key_cipher

        self._install_fake_cipher()
        key = "original-private-key"

        stored = await key_cipher.seal(key)
        recovered = await key_cipher.unseal(stored)

        self.assertNotEqual(stored, key)
        self.assertTrue(stored.startswith("v1:"))
        self.assertEqual(recovered, key)

    async def test_plaintext_round_trip_stays_untouched(self):
        """The fallback path must be identity in both directions."""
        from services import key_cipher

        key = "plaintext-key"

        self.assertEqual(await key_cipher.unseal(await key_cipher.seal(key)), key)


if __name__ == "__main__":
    unittest.main()
