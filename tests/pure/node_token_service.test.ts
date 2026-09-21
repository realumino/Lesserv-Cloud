/**
 * Node bearer-token minting, hashing, and verification.
 *
 * Ported from tests/pure/test_node_token_service.py with its assertions
 * intact, plus the Python-generated token fixture: a hash the frozen Python
 * plane computed must verify here, which pins the custody format across the
 * language change. The fixture is frozen; regenerating it needs the
 * `python-final` tag.
 */

import { describe, expect, it } from "vitest";

import {
  mintToken,
  tokenHash,
  verifyToken,
} from "../../src/services/node_token_service";
import fixture from "../fixtures/node_token.json";

describe("mintToken", () => {
  it("mints unique urlsafe text", () => {
    const first = mintToken();
    const second = mintToken();

    expect(typeof first).toBe("string");
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes to a stable 64-hex digest", async () => {
    const token = mintToken();

    const digest = await tokenHash(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await tokenHash(token)).toBe(digest);
  });
});

describe("verifyToken", () => {
  it("round-trips a minted token", async () => {
    const token = mintToken();
    const stored = await tokenHash(token);

    expect(await verifyToken(stored, token)).toBe(true);
  });

  it("fails a wrong token", async () => {
    const stored = await tokenHash(mintToken());

    expect(await verifyToken(stored, "wrong")).toBe(false);
  });

  it("never verifies a missing hash", async () => {
    for (const missing of [null, ""]) {
      expect(await verifyToken(missing, mintToken())).toBe(false);
    }
  });

  it("fails an empty presentation", async () => {
    const stored = await tokenHash(mintToken());

    expect(await verifyToken(stored, "")).toBe(false);
  });

  it("accepts a Python-computed hash", async () => {
    // WHY this is the load-bearing check: the stored hashes in production
    // were written by Python; the TS verifier must accept them byte-for-byte.
    expect(await verifyToken(fixture.sha256, fixture.token)).toBe(true);
  });
});
