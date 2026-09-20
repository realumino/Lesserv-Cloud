/**
 * config_service: turning users + config into a filled runtime config.
 *
 * Ported from tests/pure/test_config_service.py with its assertions intact.
 */

import { describe, expect, it } from "vitest";

import {
  applyRealityKeys,
  buildConfig,
  outboundTags,
  realityInboundTags,
  type User,
} from "../../src/services/config_service";

/** WHAT: the built runtime as a loosely typed dict, for deep assertions. */
type Loose = Record<string, any>;

/**
 * WHAT: a tiny stand-in for a real Xray config with one of each piece.
 *
 * WHY so small: config_service must only touch routing.rules and VLESS
 * clients; a small fixture makes the "everything else survives" checks
 * readable.
 */
function config(): Record<string, unknown> {
  return {
    log: { loglevel: "debug" },
    routing: {
      rules: [{ domain: ["example.com"], outboundTag: "OUTBOUND" }],
    },
    inbounds: [
      {
        tag: "REALITY",
        protocol: "vless",
        port: 443,
        settings: { clients: [], decryption: "none" },
      },
      {
        tag: "XHTTP",
        protocol: "vless",
        listen: "sock",
        settings: { clients: [{}] },
      },
    ],
    outbounds: [
      { tag: "OUTBOUND", protocol: "wireguard" },
      { tag: "BLOCK", protocol: "blackhole" },
    ],
  };
}

/** WHAT: one user dict in the shape db.list_users returns. */
function user(
  username: string,
  inbounds: string[],
  outbounds: string[],
  uuids: Record<string, string>,
  status = "active",
): User {
  return {
    username,
    status,
    allowed_inbounds: inbounds,
    allowed_outbounds: outbounds,
    uuids,
  };
}

/** WHAT: build a runtime and expose it loosely typed for assertions. */
function build(
  source: Record<string, unknown>,
  users: User[],
): [Loose, string[]] {
  return buildConfig(source, users) as [Loose, string[]];
}

describe("buildConfig", () => {
  it("fills clients and rules", () => {
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
    ];

    const [runtime, warnings] = build(config(), users);

    expect(runtime["inbounds"][0]["settings"]["clients"]).toEqual([
      { id: "u1", email: "alice@OUTBOUND" },
    ]);
    expect(runtime["routing"]["rules"]).toEqual([
      { domain: ["example.com"], outboundTag: "OUTBOUND" },
      { user: ["regexp:.*@OUTBOUND$"], outboundTag: "OUTBOUND" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("does not mutate the source config", () => {
    const source = config();
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
    ];

    build(source, users);

    expect(source).toEqual(config());
  });

  it("preserves opaque parts", () => {
    const source = config();
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
    ];

    const [runtime] = build(source, users);

    expect(runtime["log"]).toEqual(source["log"]);
    // outbound ORDER is panel-owned (BLOCK first), so compare as sets
    expect(
      [...runtime["outbounds"]].sort((a, b) =>
        String(a["tag"]).localeCompare(String(b["tag"])),
      ),
    ).toEqual(
      [...(source["outbounds"] as Loose[])].sort((a, b) =>
        String(a["tag"]).localeCompare(String(b["tag"])),
      ),
    );
    expect(runtime["inbounds"][0]["port"]).toBe(443);
  });

  it("gives an unused vless inbound empty clients", () => {
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
    ];

    const [runtime] = build(config(), users);

    expect(runtime["inbounds"][1]["settings"]["clients"]).toEqual([]);
  });

  it("excludes a disabled user", () => {
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
      user(
        "bob",
        ["REALITY"],
        ["OUTBOUND"],
        { "bob@OUTBOUND": "u2" },
        "disabled",
      ),
    ];

    const [runtime] = build(config(), users);

    expect(runtime["inbounds"][0]["settings"]["clients"]).toEqual([
      { id: "u1", email: "alice@OUTBOUND" },
    ]);
  });

  it("injects BLOCK first and never emits a catch-all rule", () => {
    const source = config();
    source["outbounds"] = [{ tag: "OUTBOUND", protocol: "wireguard" }];

    const [runtime, warnings] = build(source, []);

    expect(runtime["outbounds"][0]["tag"]).toBe("BLOCK");
    expect(warnings).not.toContain("no BLOCK");
    // generated rules exist even with zero users (one per outbound tag);
    // what matters here: no matcher-less catch-all rule anywhere
    for (const rule of runtime["routing"]["rules"]) {
      const matchers = Object.keys(rule).filter((key) => key !== "outboundTag");
      expect(matchers.length, `matcher-less rule: ${JSON.stringify(rule)}`).toBeGreaterThan(0);
    }
  });

  it("never emits a rule without a matcher", () => {
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
    ];

    const [runtime] = build(config(), users);

    for (const rule of runtime["routing"]["rules"]) {
      const matchers = Object.keys(rule).filter((key) => key !== "outboundTag");
      expect(
        matchers.length,
        `matcher-less rule: ${JSON.stringify(rule)} (Xray rejects these)`,
      ).toBeGreaterThan(0);
    }
  });

  it("moves an existing BLOCK to first", () => {
    const [runtime] = build(config(), []);

    expect(runtime["outbounds"].map((outbound: Loose) => outbound["tag"])).toEqual(
      ["BLOCK", "OUTBOUND"],
    );
  });

  it("preserves a customized BLOCK dict", () => {
    const source = config();
    const customized = {
      tag: "BLOCK",
      protocol: "blackhole",
      settings: { response: { type: "http" } },
    };
    source["outbounds"] = [customized, { tag: "OUTBOUND", protocol: "wireguard" }];

    const [runtime] = build(source, []);

    expect(runtime["outbounds"][0]).toEqual(customized);
  });

  it("auto-creates missing routing", () => {
    const source = config();
    delete source["routing"];
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
    ];

    const [runtime] = build(source, users);

    expect(runtime).toHaveProperty("routing");
    expect(runtime["routing"]["rules"].length).toBeGreaterThan(0);
  });

  it("preserves user rules and appends generated ones", () => {
    const source = config();
    const userRule = {
      user: ["regexp:.*@CUSTOM$"],
      outboundTag: "OUTBOUND",
    };
    (source["routing"] as Loose)["rules"] = [userRule];
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
    ];

    const [runtime] = build(source, users);

    expect(runtime["routing"]["rules"][0]).toEqual(userRule);
    expect(runtime["routing"]["rules"].length).toBeGreaterThan(1);
  });

  it("preserves other routing keys", () => {
    const source = config();
    (source["routing"] as Loose)["domainStrategy"] = "IPOnDemand";
    const users = [
      user("alice", ["REALITY"], ["OUTBOUND"], { "alice@OUTBOUND": "u1" }),
    ];

    const [runtime] = build(source, users);

    expect(runtime["routing"]["domainStrategy"]).toBe("IPOnDemand");
    expect(runtime["routing"]).toHaveProperty("rules");
  });

  it("excludes BLOCK from outbound tags", () => {
    const tags = outboundTags(config());

    expect(tags).not.toContain("BLOCK");
    expect(tags).toContain("OUTBOUND");
  });
});

/** WHAT: a config exercising the private-key fill: one REALITY, one plain. */
function realityConfig(): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "REALITY",
        protocol: "vless",
        settings: { clients: [] },
        streamSettings: {
          network: "raw",
          security: "reality",
          realitySettings: {
            target: "example.com:443",
            privateKey: "operator-key",
          },
        },
      },
      { tag: "PLAIN", protocol: "vless", settings: { clients: [] } },
    ],
    outbounds: [],
  };
}

describe("REALITY keys", () => {
  it("finds reality inbound tags by settings block", () => {
    expect(realityInboundTags(realityConfig())).toEqual(["REALITY"]);
  });

  it("ignores a reality tag without stream settings", () => {
    const source = {
      inbounds: [{ tag: "BARE", protocol: "vless" }],
      outbounds: [],
    };

    expect(realityInboundTags(source)).toEqual([]);
  });

  it("overwrites the operator's key", () => {
    const [runtime] = build(realityConfig(), []);

    const warnings = applyRealityKeys(runtime, { REALITY: "panel-key" });

    expect(runtime["inbounds"][0]["streamSettings"]["realitySettings"]).toEqual({
      target: "example.com:443",
      privateKey: "panel-key",
    });
    expect(warnings).toEqual([]);
  });

  it("warns on a missing key and keeps the config value", () => {
    const [runtime] = build(realityConfig(), []);

    const warnings = applyRealityKeys(runtime, {});

    expect(
      runtime["inbounds"][0]["streamSettings"]["realitySettings"]["privateKey"],
    ).toBe("operator-key");
    expect(warnings).toHaveLength(1);
  });

  it("does not touch the caller's config", () => {
    const source = realityConfig();
    const [runtime] = build(source, []);

    applyRealityKeys(runtime, { REALITY: "panel-key" });

    expect(source).toEqual(realityConfig());
  });
});
