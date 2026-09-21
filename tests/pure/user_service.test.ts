/**
 * Pure tests for user-service rules that guard the subscription.
 *
 * WHY these assertions matter: `isEntitled` is the whole entitlement rule —
 * getting an edge case wrong silently empties (or silently fills) a user's
 * subscription. `expire: 0` meaning "never" is the sharpest edge: it is a
 * stored convention, not an obvious one.
 */

import { describe, expect, it } from "vitest";

import {
  isEntitled,
  mintSubToken,
} from "../../src/services/user_service";

describe("isEntitled", () => {
  const user = (status: string, expire: number | null) => ({ status, expire });

  it("entitles an active user with no expiry", () => {
    expect(isEntitled(user("active", null), 1000)).toBe(true);
  });

  it("treats expire 0 as never-expiring, not as expired", () => {
    expect(isEntitled(user("active", 0), 5000)).toBe(true);
  });

  it("entitles an active user whose expiry is in the future", () => {
    expect(isEntitled(user("active", 1001), 1000)).toBe(true);
  });

  it("expires exactly at the boundary", () => {
    expect(isEntitled(user("active", 1000), 1000)).toBe(false);
  });

  it("refuses a disabled user regardless of expiry", () => {
    expect(isEntitled(user("disabled", null), 1000)).toBe(false);
    expect(isEntitled(user("disabled", 0), 1000)).toBe(false);
    expect(isEntitled(user("disabled", 5000), 1000)).toBe(false);
  });
});

describe("mintSubToken", () => {
  it("mints 43-char base64url tokens", () => {
    const token = mintSubToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("mints distinct tokens", () => {
    const seen = new Set(Array.from({ length: 16 }, () => mintSubToken()));
    expect(seen.size).toBe(16);
  });
});
