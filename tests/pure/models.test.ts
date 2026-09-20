/**
 * User models and the uuid rule.
 *
 * Ported from tests/pure/test_user_models.py with its assertions intact.
 * Zod validation and `ensureUuids` take plain values and return plain
 * values, so they run identically under any runtime. Service-level rules
 * that need a database are covered over HTTP in the workerd tier.
 */

import { describe, expect, it } from "vitest";

import { UserCreate, UserUpdate } from "../../src/models";
import { ensureUuids } from "../../src/services/user_service";

describe("UserCreate", () => {
  it("accepts a valid username and applies defaults", () => {
    const user = UserCreate.parse({ username: "alice" });

    expect(user.username).toBe("alice");
    expect(user.status).toBe("active");
    expect(user.access).toEqual({});
    expect(user.expire).toBeNull();
    expect(user.note).toBeNull();
  });

  it("defaults a node section's missing outbound list", () => {
    const user = UserCreate.parse({
      username: "alice",
      access: { tokyo01: { allowed_inbounds: ["reality"] } },
    });

    expect(user.access["tokyo01"]?.allowed_inbounds).toEqual(["reality"]);
    expect(user.access["tokyo01"]?.allowed_outbounds).toEqual([]);
  });

  it("rejects a username with '@'", () => {
    expect(UserCreate.safeParse({ username: "ali@ce" }).success).toBe(false);
  });

  it("rejects a blank username", () => {
    expect(UserCreate.safeParse({ username: "   " }).success).toBe(false);
  });

  it("rejects a username longer than 32 characters", () => {
    expect(UserCreate.safeParse({ username: "a".repeat(33) }).success).toBe(
      false,
    );
  });

  it("rejects an unknown status", () => {
    expect(
      UserCreate.safeParse({ username: "alice", status: "banned" }).success,
    ).toBe(false);
  });
});

describe("UserUpdate", () => {
  it("leaves every field optional", () => {
    const update = UserUpdate.parse({});

    expect(update.status).toBeNull();
    expect(update.expire).toBeNull();
    expect(update.note).toBeNull();
    expect(update.access).toBeNull();
  });

  it("accepts an access map or null", () => {
    expect(UserUpdate.parse({ access: {} }).access).toEqual({});
  });
});

describe("ensureUuids", () => {
  it("creates one uuid per outbound", () => {
    const uuids = ensureUuids(["jijiguo", "caibeiguo"], {});

    expect(new Set(Object.keys(uuids))).toEqual(
      new Set(["jijiguo", "caibeiguo"]),
    );
  });

  it("keeps existing uuids stable", () => {
    const first = ensureUuids(["jijiguo"], {});
    const second = ensureUuids(["jijiguo"], first);

    expect(second).toEqual(first);
  });

  it("mints only the new outbound's uuid", () => {
    const first = ensureUuids(["jijiguo"], {});
    const second = ensureUuids(["jijiguo", "caibeiguo"], first);

    expect(second["jijiguo"]).toBe(first["jijiguo"]);
    expect(second).toHaveProperty("caibeiguo");
  });
});
