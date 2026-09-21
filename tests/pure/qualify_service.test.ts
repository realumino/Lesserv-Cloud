/**
 * Node qualification: local tags become node-scoped names.
 *
 * Ported from tests/pure/test_qualify_service.py with its assertions
 * intact: every rewrite, idempotency, BLOCK exemption, copy semantics, and
 * paste-time validation is pinned before the renderer consumes it.
 */

import { describe, expect, it } from "vitest";

import {
  localTagErrors,
  qualifyConfig,
  qualifyKeys,
  qualifyProfiles,
  qualifyUsers,
  qualifiedInboundTag,
  qualifiedOutboundTag,
} from "../../src/services/qualify_service";

/** WHAT: an authored config exercising tags and every rewritten reference. */
function authoredConfig(): Record<string, unknown> {
  return {
    inbounds: [
      { tag: "reality", protocol: "vless" },
      { tag: "xhttp", protocol: "vless" },
    ],
    outbounds: [
      { tag: "niigata", protocol: "freedom" },
      { tag: "BLOCK", protocol: "blackhole" },
    ],
    routing: {
      rules: [
        { outboundTag: "niigata" },
        { outboundTag: "BLOCK" },
        { inboundTag: ["xhttp", "unknown"] },
        { user: ["regexp:.*@niigata$", "alice@niigata"] },
        { user: ["regexp:.*@unknown$", "other"] },
        { domain: ["example.com"], outboundTag: "unknown" },
      ],
    },
  };
}

/** WHAT: one projected user with local tags and uuid keys. */
function projectedUser(): Record<string, unknown> {
  return {
    username: "alice",
    status: "active",
    allowed_inbounds: ["reality", ""],
    allowed_outbounds: ["niigata", "BLOCK"],
    uuids: { "alice@niigata": "u1", "alice@BLOCK": "u2" },
  };
}

describe("tag helpers", () => {
  it("suffixes inbound tags and is idempotent", () => {
    expect(qualifiedInboundTag("reality", "tokyo01")).toBe("reality-tokyo01");
    expect(qualifiedInboundTag("reality-tokyo01", "tokyo01")).toBe(
      "reality-tokyo01",
    );
  });

  it("prefixes outbound tags, exempts BLOCK, and is idempotent", () => {
    expect(qualifiedOutboundTag("niigata", "tokyo01")).toBe("tokyo01-niigata");
    expect(qualifiedOutboundTag("tokyo01-niigata", "tokyo01")).toBe(
      "tokyo01-niigata",
    );
    expect(qualifiedOutboundTag("BLOCK", "tokyo01")).toBe("BLOCK");
  });

  it("preserves blank or missing tags", () => {
    expect(qualifiedInboundTag("", "tokyo01")).toBe("");
    expect(qualifiedOutboundTag(null, "tokyo01")).toBeNull();
  });
});

describe("qualifyConfig", () => {
  it("qualifies tags and routing references", () => {
    const qualified = qualifyConfig(authoredConfig(), "tokyo01") as {
      inbounds: { tag: string }[];
      outbounds: { tag: string }[];
      routing: { rules: unknown[] };
    };

    expect(qualified.inbounds.map((inbound) => inbound.tag)).toEqual([
      "reality-tokyo01",
      "xhttp-tokyo01",
    ]);
    expect(qualified.outbounds.map((outbound) => outbound.tag)).toEqual([
      "tokyo01-niigata",
      "BLOCK",
    ]);
    expect(qualified.routing.rules).toEqual([
      { outboundTag: "tokyo01-niigata" },
      { outboundTag: "BLOCK" },
      { inboundTag: ["xhttp-tokyo01", "unknown"] },
      {
        user: ["regexp:.*@tokyo01-niigata$", "alice@tokyo01-niigata"],
      },
      { user: ["regexp:.*@unknown$", "other"] },
      { domain: ["example.com"], outboundTag: "unknown" },
    ]);
  });

  it("does not mutate the input and is idempotent", () => {
    const source = authoredConfig();
    const once = qualifyConfig(source, "tokyo01");

    expect(source).toEqual(authoredConfig());
    expect(qualifyConfig(once, "tokyo01")).toEqual(once);
  });
});

describe("qualifyUsers, qualifyKeys, qualifyProfiles", () => {
  it("qualifies access rows and uuid keys", () => {
    const qualified = qualifyUsers([projectedUser()], "tokyo01");

    expect(qualified).toEqual([
      {
        username: "alice",
        status: "active",
        allowed_inbounds: ["reality-tokyo01", ""],
        allowed_outbounds: ["tokyo01-niigata", "BLOCK"],
        uuids: { "alice@tokyo01-niigata": "u1", "alice@BLOCK": "u2" },
      },
    ]);
  });

  it("qualifies stored keys and groups profiles by inbound", () => {
    const qualifiedKeys = qualifyKeys({ reality: "k" }, "tokyo01");
    const grouped = qualifyProfiles(
      [
        {
          id: "b",
          inbound_tag: "xhttp",
          label: "B",
          overrides: { port: 443 },
        },
        { id: "a", inbound_tag: "xhttp", label: "A", overrides: {} },
      ],
      "tokyo01",
    );

    expect(qualifiedKeys).toEqual({ "reality-tokyo01": "k" });
    expect(grouped["xhttp-tokyo01"].map((profile) => profile["id"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("is idempotent for users and keys", () => {
    const users = qualifyUsers([projectedUser()], "tokyo01");
    const keys = qualifyKeys({ reality: "k" }, "tokyo01");

    expect(qualifyUsers(users, "tokyo01")).toEqual(users);
    expect(qualifyKeys(keys, "tokyo01")).toEqual(keys);
  });
});

describe("localTagErrors", () => {
  it("accepts valid local names", () => {
    expect(localTagErrors(authoredConfig(), "tokyo01")).toEqual([]);
  });

  it("reports blank and pre-qualified tags", () => {
    const config = {
      inbounds: [{ tag: "reality-tokyo01" }, { tag: "" }],
      outbounds: [{ tag: "tokyo01-niigata" }, { tag: "BLOCK" }],
    };

    // A blank tag is invalid everywhere, but names qualified for another
    // node are local names here.
    expect(localTagErrors(config, "toyama01")).toEqual(["inbound 1 has no tag"]);

    const errors = localTagErrors(config, "tokyo01");

    expect(errors).toHaveLength(3);
    expect(errors.some((error) => error.includes("reality-tokyo01"))).toBe(true);
    expect(errors.some((error) => error.includes("tokyo01-niigata"))).toBe(true);
    expect(errors.some((error) => error.includes("has no tag"))).toBe(true);
  });

  it("reports nothing for a non-object config", () => {
    expect(localTagErrors(["inbounds"], "tokyo01")).toEqual([]);
  });
});
