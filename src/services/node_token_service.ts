/**
 * Node bearer-token operations: minting, hashing, verification.
 *
 * WHY this layer exists: a node token is effectively root on that node's
 * secrets (its rendered config holds every UUID plus the REALITY private
 * key), so the rules — high-entropy random, hash-at-rest, constant-time
 * compare, shown once — live in one audited place, not scattered across
 * routers. Only `mintToken` draws entropy, and it runs inside request
 * handlers (never at import time).
 *
 * WHY async: WebCrypto's digest is the only SHA-256 in workerd, and it is
 * a promise; the Python plane's `hashlib` was synchronous. Every caller is
 * already async (D1 has no synchronous API either).
 */

import { base64UrlEncode } from "../core/x25519";

const TOKEN_BYTES = 32;

/**
 * WHAT: mint one 32-byte random token, base64url-encoded for agent.toml.
 *
 * WHY 32 bytes: 256 bits of entropy means the stored hash cannot be
 * brute-forced, which is what makes SHA-256 (fast) the right storage
 * choice here — the opposite of password advice, where slow KDFs are
 * needed because passwords are low-entropy.
 */
export function mintToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/**
 * WHAT: return the SHA-256 hex digest stored in `nodes.token_hash`.
 *
 * WHY a hash and not the token: the plaintext is shown once at mint time
 * and never again; a database dump must not yield live tokens.
 */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * WHAT: constant-time check of a presented token against the stored hash.
 *
 * WHY constant-time and hand-rolled: a naive `==` leaks prefix information
 * through timing, letting an attacker guess the hash byte by byte; WebCrypto
 * ships no `timingSafeEqual`. A null or empty stored hash never verifies —
 * a node with no minted token authenticates nothing.
 */
export async function verifyToken(
  storedHash: string | null | undefined,
  presented: string,
): Promise<boolean> {
  if (!storedHash) {
    return false;
  }
  return timingSafeEqual(storedHash, await tokenHash(presented));
}

/**
 * WHAT: compare two strings without an early exit on the first difference.
 *
 * WHY XOR-accumulate: the loop always walks the full string, so the time
 * taken depends only on the length — which is public — not on where the
 * bytes differ. Length mismatch fails fast, exactly like
 * `hmac.compare_digest`.
 */
function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
