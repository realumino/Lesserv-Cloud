"""Pure-Python X25519 public-key derivation from a raw private scalar.

Why this exists: REALITY share links need the server's public key (`pbk`),
but the config only stores the private key. The project avoids adding the
`cryptography` dependency, so this module implements the RFC 7748 Montgomery
ladder directly.

The code is intentionally low-level: the algorithm is the algorithm — no
clever abstractions, just the standard curve25519 scalar multiplication.
"""

import base64
import os

_P = 2**255 - 19
_A24 = 121665
_BASE_POINT = 9


def _decode_scalar(private_key: str) -> bytes | None:
    """Return the 32 raw bytes of an X25519 private key, or None if invalid.

    Why this accepts both URL-safe and standard base64: Xray-generated keys
    are base64url, but the operator may paste a standard-base64 key.
    """
    if not private_key:
        return None
    padded = private_key + "=" * (-len(private_key) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded)
    except ValueError:
        return None
    if len(raw) != 32:
        return None
    return raw


def _clamp(raw: bytes) -> int:
    """Clamp the first 32 bytes of an X25519 secret and return the scalar.

    Why clamping lives here: RFC 7748 defines it as part of the X25519
    function; the stored private key may or may not already be clamped, so
    we clamp it idempotently every time.
    """
    scalar = bytearray(raw)
    scalar[0] &= 248
    scalar[31] &= 127
    scalar[31] |= 64
    return int.from_bytes(scalar, "little")


def _scalar_mult(scalar: int, u: int) -> int:
    """Montgomery ladder for curve25519 scalar multiplication.

    Why the ladder: it is constant-time with respect to the scalar and uses
    only the field prime operations, which Python's `pow` handles cleanly.
    """
    x1 = u
    x2, z2 = 1, 0
    x3, z3 = u, 1
    swap = 0

    for t in range(255, -1, -1):
        bit = (scalar >> t) & 1
        swap ^= bit
        if swap:
            x2, x3 = x3, x2
            z2, z3 = z3, z2
        swap = bit

        a = (x2 + z2) % _P
        aa = a * a % _P
        b = (x2 - z2) % _P
        bb = b * b % _P
        e = (aa - bb) % _P
        c = (x3 + z3) % _P
        d = (x3 - z3) % _P
        da = d * a % _P
        cb = c * b % _P

        x3 = (da + cb) % _P
        x3 = x3 * x3 % _P
        z3 = (da - cb) % _P
        z3 = x1 * z3 * z3 % _P
        x2 = aa * bb % _P
        z2 = e * (aa + _A24 * e) % _P

    if swap:
        x2, x3 = x3, x2
        z2, z3 = z3, z2

    return x2 * pow(z2, _P - 2, _P) % _P


def public_key_from_raw(raw: bytes) -> str:
    """Derive the base64url X25519 public key from raw 32 private bytes.

    Why this exists as a separate helper: RFC test vectors are hex byte
    strings, not base64; tests (and callers with bytes) can use this
    directly.
    """
    scalar = _clamp(raw)
    public = _scalar_mult(scalar, _BASE_POINT)
    public_bytes = public.to_bytes(32, "little")
    return base64.urlsafe_b64encode(public_bytes).decode().rstrip("=")


def generate_private_key() -> str:
    """Generate a fresh X25519 private key in Xray's base64url format.

    Why os.urandom + clamping: RFC 7748 requires the scalar to be clamped
    (bits cleared/set), which is exactly what `xray x25519` does before
    printing the key. Clamping via `_clamp` (idempotent) reuses the same
    code path that decodes keys, so a generated key round-trips through
    `derive_public_key` by construction.

    Why base64url unpadded: Xray renders REALITY keys as standard
    base64 with URL-safe alphabet and stripped padding; matching that
    byte-for-byte keeps the key valid if the operator ever copies it
    into a hand-written config.
    """
    raw = os.urandom(32)
    scalar = _clamp(raw)
    clamped = scalar.to_bytes(32, "little")
    return base64.urlsafe_b64encode(clamped).decode().rstrip("=")


def derive_public_key(private_key: str) -> str | None:
    """Derive the base64url X25519 public key from a private key string.

    Why return None on bad input: a malformed config key is not fatal; the
    caller can warn and omit the `pbk` parameter instead of crashing the link
    builder.

    Args:
        private_key: base64 (URL-safe or standard) of the 32-byte scalar.

    Returns:
        base64url-unpadded public key, or None if the input is invalid.
    """
    raw = _decode_scalar(private_key)
    if raw is None:
        return None
    return public_key_from_raw(raw)
