/**
 * Readable labels used by generated links.
 *
 * Ported from tests/pure/test_labels.py with its assertions intact: machine
 * names stay qualified while admins and end users see stable display text.
 */

import { describe, expect, it } from "vitest";

import { linkLabel, prettyTag } from "../../src/services/labels";

describe("prettyTag", () => {
  it("prettifies common tags without storing display names", () => {
    expect(prettyTag("reality")).toBe("REALITY");
    expect(prettyTag("xhttp")).toBe("XHTTP");
    expect(prettyTag("niigata")).toBe("Niigata");
    expect(prettyTag("reality_in")).toBe("REALITY IN");
  });

  it("has no display name for invalid input", () => {
    expect(prettyTag(null)).toBe("");
    expect(prettyTag("")).toBe("");
  });
});

describe("linkLabel", () => {
  it("uses the fleet-standard node, subject, exit order", () => {
    expect(linkLabel("Tokyo 01", "REALITY", "Niigata")).toBe(
      "Tokyo 01 · REALITY → Niigata",
    );
  });
});
