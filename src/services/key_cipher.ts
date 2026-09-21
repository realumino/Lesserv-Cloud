/**
 * Seal and open REALITY private keys at rest.
 *
 * WHY this module exists: the plane owns every REALITY private key, and
 * they are stored as AES-256-GCM ciphertext (`crypto.ts`,
 * `v1:<base64(iv || ct+tag)>`) with the key held in the Worker secret
 * `REALITY_KEY_SECRET`. A database dump then yields only ciphertext — that
 * is the "seatbelt" trade ARCHITECTURE.md describes.
 *
 * WHY there is no plaintext fallback: the app runs only under workerd,
 * where the secret binding always exists. A missing secret is a
 * misconfiguration that must fail loudly — it can never mean "store
 * plaintext", because a render that runs without the secret would write
 * keys it can never decrypt, and a database dump would yield plaintext.
 * The `v1:` prefix is the discriminator: `unseal` rejects anything else
 * instead of guessing, which is what makes future format rotations
 * explicit rather than silent.
 */

import { decrypt, encrypt } from "../crypto";
import { secretBytes } from "../env";

const V1_PREFIX = "v1:";

/**
 * WHAT: return the storage form of one private key: AES-GCM ciphertext.
 *
 * WHY encrypt on write: at-rest protection against a database dump. The
 * IV is minted per call by `encrypt`, so even a re-seal of the same key
 * produces different ciphertext. Callers pass the result straight to
 * `upsertRealityKey`; the usable key never needs to be re-derived from
 * storage before a render decrypts it.
 */
export async function seal(env: Env, privateKey: string): Promise<string> {
  return await encrypt(secretBytes(env), new TextEncoder().encode(privateKey));
}

/**
 * WHAT: return the usable private key from its storage form.
 *
 * WHY a strict prefix check: only `v1:` rows are meaningful, and a value
 * without the prefix is corrupt data or a row written by a misconfigured
 * render. Raising here keeps the failure at the first reader instead of
 * letting unusable key material flow into a render.
 */
export async function unseal(env: Env, stored: string): Promise<string> {
  if (!stored.startsWith(V1_PREFIX)) {
    throw new Error(
      "REALITY key is not a v1 ciphertext: it was written without the " +
        "sealing secret or the data is corrupt",
    );
  }
  return new TextDecoder().decode(await decrypt(secretBytes(env), stored));
}
