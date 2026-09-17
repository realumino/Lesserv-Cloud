"""AES-256-GCM encrypt/decrypt via the Pyodide FFI to WebCrypto.

Why WebCrypto and not a Python package: the `cryptography` package has no
Pyodide/wasm wheel, and the Worker runtime already ships WebCrypto, so the
FFI costs zero bundle size. This module is the only place that touches the
`js` module; everything else stays platform-neutral Python.

Ciphertext format matches ARCHITECTURE.md exactly:
    v1:<base64(iv || ciphertext+tag)>
The scheme prefix plus the embedded IV means the format can rotate later
without a migration, and every stored value is self-contained.
"""

import base64
import os

_IV_BYTES = 12  # 96-bit IV: NIST SP 800-38D recommendation for GCM
_V1_PREFIX = "v1:"


def _bytes_to_js(data: bytes):
    """Convert Python bytes to a JS Uint8Array for WebCrypto calls.

    Why explicit conversion: Pyodide marshals `bytes` to a read-only view
    in some paths; WebCrypto requires a real BufferSource, so building a
    JS Uint8Array is the reliable idiom. Recorded in M0 findings.
    """
    from js import Uint8Array
    from pyodide.ffi import to_js

    return Uint8Array.new(to_js(list(data)))


def _js_to_bytes(buf) -> bytes:
    """Convert a JS ArrayBuffer/Uint8Array result back to Python bytes."""
    return bytes(buf.to_bytes() if hasattr(buf, "to_bytes") else buf)


def _get_subtle():
    """Return the WebCrypto SubtleCrypto object from the JS global scope."""
    from js import crypto

    return crypto.subtle


def _list_to_js(items):
    """Convert a Python list to a real JS Array.

    Why explicit: M0 finding — a plain Python list reaches WebCrypto as a
    PyProxy, which fails `importKey`'s `sequence<KeyUsage>` check; only an
    actual JS Array satisfies it.
    """
    from pyodide.ffi import to_js

    return to_js(items)


async def _import_key(key_bytes: bytes):
    """Import 32 raw key bytes as an AES-GCM CryptoKey.

    Why await: subtle.importKey returns a JS Promise; Pyodide proxies make
    it awaitable directly. The algorithm is passed as the plain string
    "AES-GCM", which WebCrypto accepts in place of an Algorithm object.
    """
    raw = _bytes_to_js(key_bytes)
    return await _get_subtle().importKey(
        "raw", raw, "AES-GCM", False, _list_to_js(["encrypt", "decrypt"])
    )


def _split_v1(stored: str) -> tuple[bytes, bytes]:
    """Split a stored `v1:...` value into (iv, ciphertext_with_tag).

    Why a validator: a value without the prefix is corrupt or from a
    different scheme; raising here keeps every caller's error the same.
    """
    if not stored.startswith(_V1_PREFIX):
        raise ValueError("not a v1 ciphertext")
    raw = base64.b64decode(stored[len(_V1_PREFIX):])
    return raw[:_IV_BYTES], raw[_IV_BYTES:]


async def encrypt(key_bytes: bytes, plaintext: bytes) -> str:
    """Encrypt bytes into the `v1:<base64(iv || ct+tag)>` storage format.

    Why the IV is random per call: GCM with a reused (key, IV) pair is
    catastrophic, so each encryption mints a fresh 96-bit IV and stores it
    alongside the ciphertext.
    """
    iv = os.urandom(_IV_BYTES)
    key = await _import_key(key_bytes)
    params = {"name": "AES-GCM", "iv": _bytes_to_js(iv)}
    buf = await _get_subtle().encrypt(params, key, _bytes_to_js(plaintext))
    ct = _js_to_bytes(buf)
    return _V1_PREFIX + base64.b64encode(iv + ct).decode()


async def decrypt(key_bytes: bytes, stored: str) -> bytes:
    """Decrypt a `v1:...` storage value back to plaintext bytes.

    Why no try/except here: WebCrypto rejects a wrong key or tampered
    ciphertext with an OperationError; surfacing that verbatim is the
    correct behavior (authentication failure must not be swallowed).
    """
    iv, ct = _split_v1(stored)
    key = await _import_key(key_bytes)
    params = {"name": "AES-GCM", "iv": _bytes_to_js(iv)}
    buf = await _get_subtle().decrypt(params, key, _bytes_to_js(ct))
    return _js_to_bytes(buf)
