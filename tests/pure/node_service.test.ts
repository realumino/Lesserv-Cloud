/**
 * Pure rules for node rows: the reported-address pick and the out shape.
 *
 * Ported from tests/pure/test_node_service.py with its assertions intact.
 * Both functions are total over plain values — neither touches a database —
 * so they unit-test in milliseconds.
 */

import { describe, expect, it } from "vitest";

import type { NodeRow } from "../../src/db";
import { reportedAddressFor, toOut } from "../../src/services/node_service";

describe("reportedAddressFor", () => {
  it("prefers the agent report over the edge observation", () => {
    expect(reportedAddressFor("203.0.113.7", "198.51.100.9")).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to the edge header when the report is missing or blank", () => {
    expect(reportedAddressFor(null, "198.51.100.9")).toBe("198.51.100.9");
    expect(reportedAddressFor("   ", "198.51.100.9")).toBe("198.51.100.9");
  });

  it("returns null when no candidate is usable", () => {
    expect(reportedAddressFor(null, null)).toBeNull();
    expect(reportedAddressFor("", "   ")).toBeNull();
  });

  it("strips surrounding whitespace", () => {
    expect(reportedAddressFor(" 203.0.113.7 ", null)).toBe("203.0.113.7");
  });

  it("rejects oversized reports", () => {
    expect(reportedAddressFor("a".repeat(256), null)).toBeNull();
  });

  it("rejects values with embedded whitespace", () => {
    // WHY: a value with embedded whitespace is garbage, not an address.
    expect(reportedAddressFor("203.0.113.7\n198.51.100.9", null)).toBeNull();
  });
});

describe("toOut", () => {
  /** WHAT: a complete stored node row with boring defaults. */
  function nodeRow(
    configJson: Record<string, unknown> | null = null,
    reported: string | null = null,
  ): NodeRow {
    return {
      id: "tokyo01",
      label: "Tokyo 01",
      address: "funky.example.com",
      reported_address: reported,
      config_json: configJson,
      token_hash: null,
      applied_hash: null,
      last_seen: null,
      health: null,
      agent_version: null,
      xray_version: null,
      last_error: null,
      created_at: 1,
    };
  }

  it("projects the reported address and has_config", () => {
    const out = toOut(nodeRow({ inbounds: [] }, "203.0.113.7"));

    expect(out.reported_address).toBe("203.0.113.7");
    expect(out.has_config).toBe(true);
  });

  it("reports null and false for an empty row", () => {
    const out = toOut(nodeRow());

    expect(out.reported_address).toBeNull();
    expect(out.has_config).toBe(false);
  });
});
