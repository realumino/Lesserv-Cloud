/**
 * The copied allocator: pure dict in, pure dict out.
 *
 * Ported from tests/pure/test_allocator.py with its assertions intact.
 */

import { describe, expect, it } from "vitest";

import { allocate } from "../../src/core/allocator";

describe("allocate", () => {
  it("builds clients per inbound", () => {
    const permissions = {
      alice: {
        allowed_inbounds: ["REALITY"],
        allowed_outbounds: ["OUTBOUND"],
      },
    };
    const inbounds = [{ tag: "REALITY", protocol: "vless" }];
    const uuids = { "alice@OUTBOUND": "uuid-1" };

    const [clients, , warnings] = allocate(
      permissions,
      inbounds,
      ["OUTBOUND"],
      uuids,
    );

    expect(clients).toEqual({
      REALITY: [{ id: "uuid-1", email: "alice@OUTBOUND" }],
    });
    expect(warnings).toEqual([]);
  });

  it("emits one routing rule per outbound", () => {
    const [, rules] = allocate({}, [], ["OUTBOUND", "BLOCK"], {});

    expect(rules).toEqual([
      { user: ["regexp:.*@OUTBOUND$"], outboundTag: "OUTBOUND" },
      { user: ["regexp:.*@BLOCK$"], outboundTag: "BLOCK" },
    ]);
  });

  it("skips a non-vless inbound with a warning", () => {
    const permissions = {
      alice: { allowed_inbounds: ["DNS"], allowed_outbounds: ["OUTBOUND"] },
    };
    const inbounds = [{ tag: "DNS", protocol: "dokodemo-door" }];
    const uuids = { "alice@OUTBOUND": "uuid-1" };

    const [clients, , warnings] = allocate(
      permissions,
      inbounds,
      ["OUTBOUND"],
      uuids,
    );

    expect(clients).toEqual({});
    expect(warnings).toContain("skipping non-vless inbound 'DNS'");
  });

  it("warns on a missing uuid", () => {
    const permissions = {
      alice: {
        allowed_inbounds: ["REALITY"],
        allowed_outbounds: ["OUTBOUND"],
      },
    };
    const inbounds = [{ tag: "REALITY", protocol: "vless" }];

    const [clients, , warnings] = allocate(permissions, inbounds, ["OUTBOUND"], {});

    expect(clients).toEqual({});
    expect(warnings).toContain("missing uuid for 'alice@OUTBOUND'");
  });
});
