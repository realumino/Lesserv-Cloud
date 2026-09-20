/** Pin the fleet row join, including the missing-sync case. */

import { describe, expect, it } from "vitest";

import type { NodeOut, NodeSyncOut } from "../types";
import { fleetRows, fleetState } from "./fleet";

function node(id: string): NodeOut {
  return { id, label: id, address: "", created_at: 0, has_config: true };
}

function sync(overrides: Partial<NodeSyncOut>): NodeSyncOut {
  return {
    node_id: "n",
    state: "active",
    desired_hash: "d",
    applied_hash: "a",
    in_sync: true,
    last_seen: 1,
    health: "ok",
    agent_version: null,
    xray_version: null,
    last_error: null,
    warnings: [],
    ...overrides,
  };
}

describe("fleetState", () => {
  it("returns unknown when no sync was fetched", () => {
    expect(fleetState(null)).toBe("unknown");
  });

  it("prefers in-sync, then error, then drift", () => {
    expect(fleetState(sync({}))).toBe("in-sync");
    expect(fleetState(sync({ in_sync: false, last_error: "boom" }))).toBe("error");
    expect(fleetState(sync({ in_sync: false }))).toBe("drifted");
  });

  it("distinguishes no config and never-applied nodes", () => {
    expect(fleetState(sync({ desired_hash: null, in_sync: false }))).toBe(
      "no-config",
    );
    expect(
      fleetState(sync({ applied_hash: null, in_sync: false, last_seen: null })),
    ).toBe("pending");
  });
});

describe("fleetRows", () => {
  it("preserves node order and pairs each node with its sync", () => {
    const rows = fleetRows(
      [node("tokyo01"), node("osaka02")],
      { tokyo01: sync({ in_sync: false }) },
    );

    expect(rows.map((row) => row.node.id)).toEqual(["tokyo01", "osaka02"]);
    expect(rows[0].state).toBe("drifted");
    expect(rows[1].sync).toBeNull();
    expect(rows[1].state).toBe("unknown");
  });
});
