/**
 * X25519 derivation against RFC 7748 and Python-generated fixtures.
 *
 * WHY both: RFC vectors prove the curve math, and the Python-generated
 * keypairs prove the port's decode/clamp/encode path agrees with the frozen
 * implementation byte-for-byte — a wrong `pbk` breaks every REALITY client.
 */

import { describe, expect, it } from "vitest";

import {
  base64UrlEncode,
  decodeScalar,
  derivePublicKey,
  generatePrivateKey,
  publicKeyFromRaw,
} from "../../src/core/x25519";
import fixture from "../fixtures/x25519.json";

/** WHAT: decode a hex string into bytes for the RFC vectors. */
function bytesFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

describe("publicKeyFromRaw", () => {
  it("derives every RFC 7748 vector", () => {
    for (const vector of fixture.rfc7748) {
      expect(
        publicKeyFromRaw(bytesFromHex(vector.private_hex)),
        vector.name,
      ).toBe(base64UrlEncode(bytesFromHex(vector.public_hex)));
    }
  });
});

describe("derivePublicKey", () => {
  it("derives the project's fixed keypair", () => {
    expect(derivePublicKey(fixture.fixed.private)).toBe(fixture.fixed.public);
  });

  it("derives every Python-generated keypair", () => {
    for (const pair of fixture.generated) {
      expect(derivePublicKey(pair.private)).toBe(pair.public);
    }
  });

  it("accepts the standard base64 form with padding", () => {
    expect(derivePublicKey(fixture.padded_variant.padded)).toBe(
      derivePublicKey(fixture.padded_variant.unpadded),
    );
  });

  it("returns null for empty, malformed, or short input", () => {
    for (const invalid of fixture.invalid) {
      expect(derivePublicKey(invalid), invalid).toBeNull();
    }
  });
});

describe("generatePrivateKey", () => {
  it("emits a clamped 32-byte base64url-unpadded scalar", () => {
    const key = generatePrivateKey();
    const raw = decodeScalar(key);

    expect(raw).not.toBeNull();
    expect(key).not.toContain("=");
    expect(key).not.toContain("+");
    expect(key).not.toContain("/");
    expect(raw?.[0]! & 248).toBe(raw?.[0]);
    expect(raw?.[31]! & 127).toBe(raw?.[31]);
    expect(raw?.[31]! | 64).toBe(raw?.[31]);
  });

  it("round-trips through derivation", () => {
    expect(derivePublicKey(generatePrivateKey())).not.toBeNull();
  });

  it("does not repeat", () => {
    expect(generatePrivateKey()).not.toBe(generatePrivateKey());
  });
});
