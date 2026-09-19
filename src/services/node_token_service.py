"""Node bearer-token operations: minting, hashing, verification.

Why this layer exists: a node token is effectively root on that node's
secrets (its rendered config holds every UUID plus the REALITY private
key), so the rules — high-entropy random, hash-at-rest, constant-time
compare, shown once — live in one audited place, not scattered across
routers. All functions are synchronous and pure except `mint_token`,
which draws entropy and therefore must only run inside request handlers
(see tests/test_import_hygiene.py).
"""

import hashlib
import hmac
import secrets


def mint_token() -> str:
    """Mint one 32-byte random token, base64url-encoded for agent.toml.

    Why 32 bytes: 256 bits of entropy means the stored hash cannot be
    brute-forced, which is what makes SHA-256 (fast) the right storage
    choice here — the opposite of password advice, where slow KDFs are
    needed because passwords are low-entropy.
    """
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    """Return the SHA-256 hex digest stored in `nodes.token_hash`.

    Why a hash and not the token: the plaintext is shown once at mint
    time and never again; a database dump must not yield live tokens.
    """
    return hashlib.sha256(token.encode()).hexdigest()


def verify_token(stored_hash: str | None, presented: str) -> bool:
    """Constant-time check of a presented token against the stored hash.

    Why constant-time: a naive `==` leaks prefix information through
    timing, letting an attacker guess the hash byte by byte. `None` or
    empty stored hashes never verify — a node with no minted token
    authenticates nothing.
    """
    if not stored_hash:
        return False
    candidate = hashlib.sha256(presented.encode()).hexdigest()
    return hmac.compare_digest(stored_hash, candidate)
