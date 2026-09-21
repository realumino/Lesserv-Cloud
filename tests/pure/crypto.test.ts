/**
 * AES-256-GCM envelope and REALITY-key custody.
 *
 * WHY these tests are load-bearing: production rows were sealed by the
 * Python plane under REALITY_KEY_SECRET, so a single divergence in the
 * envelope (base64 alphabet, IV placement, appended tag, secret decoding)
 * turns every render into an outage. There was no Python unit test for
 * `crypto.py`; the fixture under tests/fixtures/crypto.json — a published
 * AES-256-GCM vector plus a realistic sealed key — is the oracle the
 * rewrite plan calls for, and workerd's WebCrypto re-verifies it here.
 */

import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  decrypt,
  encrypt,
} from "../../src/crypto";
import { secretBytes } from "../../src/env";
import { seal, unseal } from "../../src/services/key_cipher";
import fixture from "../fixtures/crypto.json";

/** WHAT: decode a hex string into bytes (fixture keys/tags travel as hex). */
function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

/** WHAT: an Env carrying only the sealing secret, for custody tests. */
function envWith(secret: string): Env {
  return { REALITY_KEY_SECRET: secret } as Env;
}

const secretEnv = envWith(fixture.sealed_key.secret_b64);

describe("encrypt/decrypt", () => {
  it("round-trips arbitrary bytes", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode("a REALITY private key");

    const stored = await encrypt(key, plaintext);

    expect(stored.startsWith("v1:")).toBe(true);
    expect(await decrypt(key, stored)).toEqual(plaintext);
  });

  it("encodes the published vector into the exact Python envelope", () => {
    // WHY bytesToBase64 and not the TS decryptor: this pins the storage
    // alphabet (standard base64, padded) against the Python-produced
    // `stored` string byte-for-byte, independent of decryption.
    const combined = new Uint8Array([
      ...fromHex(fixture.standard_vector.iv_hex),
      ...fromHex(fixture.standard_vector.ciphertext_hex),
      ...fromHex(fixture.standard_vector.tag_hex),
    ]);

    expect("v1:" + bytesToBase64(combined)).toBe(fixture.standard_vector.stored);
  });

  it("decrypts the published AES-256-GCM vector", async () => {
    const key = fromHex(fixture.standard_vector.key_hex);

    const decrypted = await decrypt(key, fixture.standard_vector.stored);

    expect(decrypted).toEqual(fromHex(fixture.standard_vector.plaintext_hex));
  });

  it("uses a fresh IV per call", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode("same plaintext");

    const first = await encrypt(key, plaintext);
    const second = await encrypt(key, plaintext);

    expect(first).not.toBe(second);
    expect(await decrypt(key, second)).toEqual(plaintext);
  });

  it("rejects a wrong key", async () => {
    const stored = await encrypt(
      crypto.getRandomValues(new Uint8Array(32)),
      new TextEncoder().encode("secret"),
    );

    await expect(
      decrypt(crypto.getRandomValues(new Uint8Array(32)), stored),
    ).rejects.toThrow();
  });

  it("rejects a tampered ciphertext", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const stored = await encrypt(key, new TextEncoder().encode("secret"));
    const at = stored.length - 5;
    const tampered =
      stored.slice(0, at) + (stored[at] === "A" ? "B" : "A") + stored.slice(at + 1);

    await expect(decrypt(key, tampered)).rejects.toThrow();
  });

  it("rejects a value without the v1 prefix", async () => {
    await expect(decrypt(new Uint8Array(32), "plain:value")).rejects.toThrow(
      "not a v1 ciphertext",
    );
  });
});

describe("key_cipher", () => {
  it("unseals a Python-produced sealed key", async () => {
    expect(await unseal(secretEnv, fixture.sealed_key.stored)).toBe(
      fixture.sealed_key.plaintext,
    );
  });

  it("round-trips seal and unseal", async () => {
    const sealed = await seal(secretEnv, fixture.sealed_key.plaintext);

    expect(sealed.startsWith("v1:")).toBe(true);
    expect(await unseal(secretEnv, sealed)).toBe(fixture.sealed_key.plaintext);
  });

  it("re-seals with a fresh IV every time", async () => {
    const first = await seal(secretEnv, fixture.sealed_key.plaintext);
    const second = await seal(secretEnv, fixture.sealed_key.plaintext);

    expect(first).not.toBe(second);
  });

  it("refuses a value that is not a v1 ciphertext", async () => {
    await expect(unseal(secretEnv, "not-sealed")).rejects.toThrow(
      /not a v1 ciphertext/,
    );
  });

  it("refuses to seal or unseal without the secret", async () => {
    const emptyEnv = envWith("");

    await expect(seal(emptyEnv, "key")).rejects.toThrow(
      /REALITY_KEY_SECRET is not configured/,
    );
    await expect(
      unseal(emptyEnv, fixture.sealed_key.stored),
    ).rejects.toThrow(/REALITY_KEY_SECRET is not configured/);
  });

  it("tolerates a BOM and surrounding whitespace on the secret", async () => {
    const padded = envWith("\uFEFF" + fixture.sealed_key.secret_b64 + "\r\n");

    expect(await unseal(padded, fixture.sealed_key.stored)).toBe(
      fixture.sealed_key.plaintext,
    );
    expect(secretBytes(padded)).toEqual(base64ToBytes(fixture.sealed_key.secret_b64));
  });
});
