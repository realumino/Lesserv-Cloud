/**
 * The heartbeat cheap-write rule, without any environment.
 *
 * Ported from tests/pure/test_node_state.py with its assertions intact.
 * `shouldTouch` compares a stored row with desired values, so it runs
 * identically under any runtime.
 */

import { describe, expect, it } from "vitest";

import {
  shouldTouch,
  type LivenessValues,
} from "../../src/services/node_state_service";

/** WHAT: the stored liveness columns the rule reads. */
type LivenessRow = Parameters<typeof shouldTouch>[0];

/** WHAT: a stored row with boring defaults. */
function storedRow(overrides: Partial<LivenessRow> = {}): LivenessRow {
  return {
    last_seen: 1000,
    health: "ok",
    agent_version: "0.1.0",
    xray_version: "25.1.1",
    last_error: null,
    applied_hash: "abc",
    ...overrides,
  };
}

/** WHAT: desired values identical to the stored row by default. */
function values(overrides: Partial<LivenessValues> = {}): LivenessValues {
  return {
    last_seen: 1000,
    health: "ok",
    agent_version: "0.1.0",
    xray_version: "25.1.1",
    last_error: null,
    applied_hash: "abc",
    ...overrides,
  };
}

describe("shouldTouch", () => {
  it("always writes on first contact", () => {
    expect(shouldTouch(storedRow({ last_seen: null }), values(), 1000)).toBe(
      true,
    );
  });

  it("writes when liveness went stale", () => {
    expect(shouldTouch(storedRow({ last_seen: 1000 }), values(), 1061)).toBe(
      true,
    );
  });

  it("skips a fresh identical heartbeat", () => {
    expect(shouldTouch(storedRow({ last_seen: 1000 }), values(), 1059)).toBe(
      false,
    );
  });

  it("writes when a fact changed even while fresh", () => {
    expect(
      shouldTouch(storedRow(), values({ applied_hash: "def" }), 1001),
    ).toBe(true);
  });
});
