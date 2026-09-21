/**
 * X25519 public-key derivation for REALITY share links.
 *
 * WHY this exists: links need the server's public key (`pbk`), but the
 * stored config only carries the private key. The Python plane hand-rolled
 * the RFC 7748 Montgomery ladder to avoid a dependency; the TS plane uses
 * the audited `@noble/curves` implementation and keeps the Python module's
 * observable behavior: both base64 alphabets accepted, padding-agnostic,
 * explicit RFC 7748 clamping, and base64url-unpadded output.
 */

import { x25519 } from "@noble/curves/ed25519.js";

const SCALAR_LENGTH = 32;

/**
 * WHAT: encode raw bytes as base64url without padding.
 *
 * WHY: Xray renders REALITY keys with the URL-safe alphabet and stripped
 * padding; matching that byte-for-byte keeps a generated key valid if the
 * operator copies it into a hand-written config.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * WHAT: decode one 32-byte private scalar, or null when it is unusable.
 *
 * WHY this accepts both alphabets and ignores stray characters: Xray emits
 * base64url, operators paste standard base64, and Python's `b64decode`
 * discarded invalid characters before length-checking. Returning null
 * instead of throwing keeps a malformed config key from crashing the link
 * builder — the caller warns and omits `pbk`.
 */
export function decodeScalar(privateKey: string): Uint8Array | null {
  if (!privateKey) {
    return null;
  }
  const translated = privateKey.replaceAll("-", "+").replaceAll("_", "/");
  const cleaned = translated.replace(/[^A-Za-z0-9+/]/g, "");
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
  let raw: Uint8Array;
  try {
    const binary = atob(padded);
    raw = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  return raw.length === SCALAR_LENGTH ? raw : null;
}

/**
 * WHAT: apply RFC 7748 clamping to a private scalar.
 *
 * WHY: clamping is part of the X25519 function itself, and a stored key may
 * or may not already be clamped; applying it idempotently means generated
 * and pasted keys travel the same code path. A copy is returned so callers
 * never mutate stored bytes.
 */
export function clampScalar(raw: Uint8Array): Uint8Array {
  const clamped = Uint8Array.from(raw);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  return clamped;
}

/**
 * WHAT: derive the base64url public key from raw 32 private bytes.
 *
 * WHY a bytes-in helper: RFC 7748 test vectors are hex byte strings, so
 * tests and callers holding bytes need a path that skips base64 decoding.
 */
export function publicKeyFromRaw(raw: Uint8Array): string {
  const publicBytes = x25519.getPublicKey(clampScalar(raw));
  return base64UrlEncode(publicBytes);
}

/**
 * WHAT: generate a fresh X25519 private key in Xray's base64url format.
 *
 * WHY clamping before encoding: `xray x25519` prints an already-clamped
 * scalar, and storing the clamped form means the key round-trips through
 * `derivePublicKey` by construction. Randomness comes from WebCrypto, which
 * exists in workerd and matches Python's `os.urandom` role.
 */
export function generatePrivateKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(SCALAR_LENGTH));
  return base64UrlEncode(clampScalar(raw));
}

/**
 * WHAT: derive the base64url public key from a private key string.
 *
 * WHY null on bad input: a malformed config key is not fatal; the caller
 * warns and omits `pbk` instead of failing the whole link build.
 */
export function derivePublicKey(privateKey: string): string | null {
  const raw = decodeScalar(privateKey);
  if (raw === null) {
    return null;
  }
  return publicKeyFromRaw(raw);
}
