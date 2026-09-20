"""Seal and open REALITY private keys at rest.

WHY this module exists: the plane owns every REALITY private key, and
they are stored as AES-256-GCM ciphertext (crypto.py,
`v1:<base64(iv || ct+tag)>`) with the key held in the Worker secret
`REALITY_KEY_SECRET`. A database dump then yields only ciphertext — that
is the "seatbelt" trade ARCHITECTURE.md describes.

WHY there is no plaintext fallback: the app runs only under workerd,
where the secret binding always exists. A missing secret is a
misconfiguration that must fail loudly — it can never mean "store
plaintext", because a render that runs without the secret would write
keys it can never decrypt, and a database dump would yield plaintext.
The `v1:` prefix is the discriminator: `unseal` rejects anything else
instead of guessing, which is what makes future format rotations
explicit rather than silent.
"""

import base64

_SECRET_NAME = "REALITY_KEY_SECRET"
_V1_PREFIX = "v1:"


def _secret_bytes() -> bytes:
    """Return the 32 secret bytes, or raise when the binding is absent.

    WHY a function-local import: `workers` imports the `js` module at
    import time and cannot be imported outside workerd. Deferring the
    import keeps every module that ships importable at deploy time, and
    the runtime failure stays loud and exactly here.
    """
    from workers import env

    raw = getattr(env, _SECRET_NAME, None)
    if not raw:
        raise RuntimeError(
            f"{_SECRET_NAME} is not configured; REALITY keys cannot be "
            "sealed or unsealed without it"
        )
    # Windows PowerShell pipes text to native programs with a leading BOM;
    # strip it (and any whitespace) before decoding the base64 payload.
    return base64.b64decode(str(raw).strip().lstrip("﻿"))


async def seal(private_key: str) -> str:
    """Return the storage form of one private key: AES-GCM ciphertext.

    WHY encrypt on write: at-rest protection against a database dump. The
    IV is minted per call by crypto.encrypt, so even a re-seal of the
    same key produces different ciphertext. Callers pass the result
    straight to `upsert_reality_key`; the usable key never needs to be
    re-derived from storage before a render decrypts it.
    """
    from crypto import encrypt

    return await encrypt(_secret_bytes(), private_key.encode("utf-8"))


async def unseal(stored: str) -> str:
    """Return the usable private key from its storage form.

    WHY a strict prefix check: only `v1:` rows are meaningful, and a
    value without the prefix is corrupt data or a row written by a
    misconfigured render. Raising here keeps the failure at the first
    reader instead of letting unusable key material flow into a render.
    """
    if not stored.startswith(_V1_PREFIX):
        raise ValueError(
            "REALITY key is not a v1 ciphertext: it was written without "
            "the sealing secret or the data is corrupt"
        )
    from crypto import decrypt

    return (await decrypt(_secret_bytes(), stored)).decode("utf-8")
