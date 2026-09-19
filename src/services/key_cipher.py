"""Seal and open REALITY private keys at rest.

WHY this module exists: the plane owns every REALITY private key, and from
M4 they are stored as AES-256-GCM ciphertext (crypto.py,
`v1:<base64(iv || ct+tag)>`) with the key held in the Worker secret
`REALITY_KEY_SECRET`. A database dump then yields only ciphertext — that is
the "seatbelt" trade ARCHITECTURE.md describes, and the one M4 done-when
depends on.

WHY the plaintext fallback: crypto.py speaks WebCrypto, which exists only
inside workerd, and the secret is a Worker binding that does not exist
under CPython (local uvicorn, tests). Outside the Worker there is no cipher
and nothing to protect — the dev database is disposable — so `seal` passes
plaintext through and `unseal` accepts legacy plaintext rows. The `v1:`
prefix is the discriminator, which is why every stored value is
self-describing and no migration is needed to introduce (or, later,
rotate) the scheme.
"""

import base64

_SECRET_NAME = "REALITY_KEY_SECRET"
_V1_PREFIX = "v1:"


def _secret_bytes() -> bytes | None:
    """Return the 32 secret bytes, or None when running outside workerd.

    WHY a function-local import: `workers` imports the `js` module at top
    level and raises under CPython, so it must never be imported at module
    scope (import hygiene plus the one-app-two-runtimes rule). A missing
    binding means local dev or tests: store plaintext, exactly as before
    M4.
    """
    try:
        from workers import env
    except ImportError:
        return None
    raw = getattr(env, _SECRET_NAME, None)
    if not raw:
        return None
    # Windows PowerShell pipes text to native programs with a leading BOM;
    # strip it (and any whitespace) before decoding the base64 payload.
    return base64.b64decode(str(raw).strip().lstrip("﻿"))


async def seal(private_key: str) -> str:
    """Return the storage form of one private key: ciphertext when possible.

    WHY encrypt on write: at-rest protection against a database dump. The
    IV is minted per call by crypto.encrypt, so even a re-seal of the same
    key produces different ciphertext. Callers pass the result straight to
    `upsert_reality_key`; the usable key never needs to be re-derived from
    storage before a render decrypts it.
    """
    key = _secret_bytes()
    if key is None:
        return private_key
    from crypto import encrypt

    return await encrypt(key, private_key.encode("utf-8"))


async def unseal(stored: str) -> str:
    """Return the usable private key from its storage form.

    WHY tolerate plaintext: rows written before M4 (or on a dev machine)
    have no `v1:` prefix and are already usable. A ciphertext row without
    the secret cannot be read at all — raising is correct, because a
    misconfigured Worker must fail loudly rather than serve or leak
    anything half-decrypted.
    """
    if not stored.startswith(_V1_PREFIX):
        return stored
    key = _secret_bytes()
    if key is None:
        raise RuntimeError(
            "REALITY key is stored encrypted but "
            f"{_SECRET_NAME} is not configured"
        )
    from crypto import decrypt

    return (await decrypt(key, stored)).decode("utf-8")
