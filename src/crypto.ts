/**
 * AES-256-GCM encrypt/decrypt via WebCrypto, in the `v1:` storage format.
 *
 * WHY WebCrypto and not a library: workerd ships it, so it costs zero
 * bundle size and no dependency — the Python plane reached the same
 * primitive through Pyodide's FFI, and this port talks to it directly.
 * This module is the only place in the app that encrypts or decrypts.
 *
 * Ciphertext format matches ARCHITECTURE.md exactly:
 *     v1:<base64(iv || ciphertext+tag)>
 * The scheme prefix plus the embedded IV means the format can rotate later
 * without a migration, and every stored value is self-contained.
 */

const IV_BYTES = 12; // 96-bit IV: NIST SP 800-38D recommendation for GCM
const V1_PREFIX = "v1:";

/**
 * WHAT: encode raw bytes as standard base64 with padding.
 *
 * WHY standard and not url-safe: this is the `v1:` storage alphabet, the
 * one Python's `base64.b64encode` produced; keys and tokens use their own
 * url-safe helpers.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * WHAT: decode standard base64 (with padding) into bytes.
 *
 * WHY atob and not a dependency: workerd ships it, the stored format is
 * produced by `base64.b64encode` above, and malformed input must throw
 * rather than be guessed at.
 */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * WHAT: join byte arrays into one fresh Uint8Array.
 *
 * WHY: the envelope stores IV and ciphertext as one contiguous blob, so
 * the primitive's two outputs must become one buffer before encoding.
 */
function concatenate(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * WHAT: import 32 raw key bytes as an AES-GCM CryptoKey.
 *
 * WHY non-extractable and usage-scoped: nothing needs the raw key back out
 * of WebCrypto, and only this module ever uses it, so the narrowest
 * import is the safe one.
 */
async function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * WHAT: split a stored `v1:...` value into (iv, ciphertext+tag).
 *
 * WHY a validator: a value without the prefix is corrupt or from a
 * different scheme; raising here keeps every caller's error the same.
 */
function splitV1(stored: string): { iv: Uint8Array; ciphertext: Uint8Array } {
  if (!stored.startsWith(V1_PREFIX)) {
    throw new Error("not a v1 ciphertext");
  }
  const raw = base64ToBytes(stored.slice(V1_PREFIX.length));
  return { iv: raw.slice(0, IV_BYTES), ciphertext: raw.slice(IV_BYTES) };
}

/**
 * WHAT: encrypt bytes into the `v1:<base64(iv || ct+tag)>` storage format.
 *
 * WHY the IV is random per call: GCM with a reused (key, IV) pair is
 * catastrophic, so each encryption mints a fresh 96-bit IV and stores it
 * alongside the ciphertext.
 */
export async function encrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(keyBytes);
  const params = { name: "AES-GCM", iv };
  const buffer = await crypto.subtle.encrypt(params, key, plaintext);
  const combined = concatenate([iv, new Uint8Array(buffer)]);
  return V1_PREFIX + bytesToBase64(combined);
}

/**
 * WHAT: decrypt a `v1:...` storage value back to plaintext bytes.
 *
 * WHY no try/except here: WebCrypto rejects a wrong key or tampered
 * ciphertext with an OperationError; surfacing that verbatim is the
 * correct behavior (authentication failure must not be swallowed).
 */
export async function decrypt(
  keyBytes: Uint8Array,
  stored: string,
): Promise<Uint8Array> {
  const { iv, ciphertext } = splitV1(stored);
  const key = await importKey(keyBytes);
  const params = { name: "AES-GCM", iv };
  const buffer = await crypto.subtle.decrypt(params, key, ciphertext);
  return new Uint8Array(buffer);
}
