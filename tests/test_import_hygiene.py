"""Prove the app's import is free of entropy and side effects.

Why this matters: at deploy time Cloudflare executes the Worker's
top-level scope and takes a memory snapshot, with the PRNG poisoned —
any entropy call at import time fails the deploy (Python Workers redux,
Dec 2025). Key generation and UUIDs must therefore happen at request
time, inside handlers. This test fails if anyone ever moves those calls
to module scope.
"""

import os
import unittest
from unittest import mock


def _poison():
    """Replace every entropy source with something that raises."""
    return (
        mock.patch("os.urandom", side_effect=AssertionError("entropy at import time")),
        mock.patch("secrets.token_bytes", side_effect=AssertionError("entropy at import time")),
        mock.patch("uuid.uuid4", side_effect=AssertionError("uuid4 at import time")),
    )


class TestImportHygiene(unittest.TestCase):
    """The deploy snapshot rejects entropy at top-level scope; we reject it first."""

    def test_importing_the_app_needs_no_entropy(self):
        import sys

        patches = _poison()
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

        for name in [m for m in list(sys.modules) if m in ("main", "local", "db", "checks")]:
            del sys.modules[name]

        import main  # noqa: F401 - the import itself is the assertion
        import local  # noqa: F401

    def test_key_generation_still_works_at_request_time(self):
        """The poison only applies to import; runtime calls are legitimate."""
        from core import x25519

        self.assertIsNotNone(x25519.derive_public_key(x25519.generate_private_key()))


if __name__ == "__main__":
    unittest.main()
