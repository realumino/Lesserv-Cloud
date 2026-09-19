"""Prove the app's import is free of entropy and side effects.

Why this matters: at deploy time Cloudflare executes the Worker's
top-level scope and takes a memory snapshot, with the PRNG poisoned —
any entropy call at import time fails the deploy (Python Workers redux,
Dec 2025). Key generation and UUIDs must therefore happen at request
time, inside handlers.

Why a subprocess: purging app modules from this process's sys.modules
would leave other already-imported test modules holding stale objects,
so their patches would miss the code they mean to test. A fresh
interpreter has no such aliasing, and the deploy-time import is exactly
a fresh process's import.
"""

import subprocess
import sys
import unittest
import textwrap


_POISON_IMPORT = textwrap.dedent(
    """
    import os, secrets, sys, uuid

    sys.path.insert(0, "src")

    def _poison(*args, **kwargs):
        raise AssertionError("entropy at import time")

    os.urandom = _poison
    secrets.token_bytes = _poison
    uuid.uuid4 = _poison

    import main  # noqa: F401 - the import itself is the assertion
    import local  # noqa: F401
    import services.labels  # noqa: F401
    import services.key_cipher  # noqa: F401
    import services.link_profile_service  # noqa: F401
    import services.link_service  # noqa: F401
    import services.node_state_service  # noqa: F401
    import services.node_token_service  # noqa: F401
    import services.qualify_service  # noqa: F401
    import routers.node  # noqa: F401
    print("clean")
    """
)


class TestImportHygiene(unittest.TestCase):
    """The deploy snapshot rejects entropy at top-level scope; we reject it first."""

    def test_importing_the_app_needs_no_entropy(self):
        result = subprocess.run(
            [sys.executable, "-c", _POISON_IMPORT],
            capture_output=True,
            text=True,
            timeout=60,
        )

        self.assertEqual(
            result.returncode, 0,
            "import failed under poisoned entropy:\n" + result.stderr,
        )
        self.assertIn("clean", result.stdout)

    def test_key_generation_still_works_at_request_time(self):
        """The poison only applies to import; runtime calls are legitimate."""
        from core import x25519

        self.assertIsNotNone(x25519.derive_public_key(x25519.generate_private_key()))


if __name__ == "__main__":
    unittest.main()
