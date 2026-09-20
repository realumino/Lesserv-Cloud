/**
 * Canonical-JSON parity against Python-generated fixtures.
 *
 * WHY fixtures and not hand-written expectations: `config_hash` is the
 * agent's sync contract, and these vectors were produced by the frozen
 * Python implementation. The `known_limits` block pins the one place the
 * port cannot match (whole-number floats after JSON.parse) so it stays
 * visible until the pre-cutover audit retires it.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  compareCodePoints,
  pyFloatRepr,
  pyStr,
} from "../../src/core/python_json";
import fixture from "../fixtures/python_json.json";

/**
 * WHAT: one canonical-JSON vector, widened from the JSON import's types.
 *
 * WHY `value_units`: a lone surrogate cannot survive the JS toolchain's
 * JSON import (esbuild rejects the escape), so that one vector carries
 * UTF-16 code units and is rebuilt here.
 */
type CanonicalVector = {
  name: string;
  value?: unknown;
  value_units?: number[];
  python: string;
};

/** WHAT: return the vector's input, rebuilding code-unit-only values. */
function vectorValue(vector: CanonicalVector): unknown {
  return vector.value_units
    ? String.fromCharCode(...vector.value_units)
    : vector.value;
}

describe("canonicalJson", () => {
  it("matches every Python-generated vector", () => {
    for (const vector of fixture.vectors as unknown as CanonicalVector[]) {
      expect(canonicalJson(vectorValue(vector)), vector.name).toBe(vector.python);
    }
  });

  it("pins the documented JSON.parse limits", () => {
    for (const limit of fixture.known_limits) {
      expect(canonicalJson(limit.value), limit.name).toBe(limit.typescript);
      expect(limit.typescript, limit.name).not.toBe(limit.python);
    }
  });

  it("reproduces the Python hash of a rendered config", async () => {
    const canonical = canonicalJson(fixture.rendered_config.config);

    expect(canonical).toBe(fixture.rendered_config.canonical);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(fixture.rendered_config.sha256);
  });
});

describe("pyFloatRepr", () => {
  it("uses Python's fixed form inside the -4..15 exponent range", () => {
    expect(pyFloatRepr(100.0)).toBe("100.0");
    expect(pyFloatRepr(1e15)).toBe("1000000000000000.0");
    expect(pyFloatRepr(0.0001)).toBe("0.0001");
    expect(pyFloatRepr(-2.5)).toBe("-2.5");
  });

  it("uses Python's signed two-digit exponent outside that range", () => {
    expect(pyFloatRepr(1e-5)).toBe("1e-05");
    expect(pyFloatRepr(1.5e-7)).toBe("1.5e-07");
    expect(pyFloatRepr(1e16)).toBe("1e+16");
    expect(pyFloatRepr(1e21)).toBe("1e+21");
  });

  it("keeps Python's special forms", () => {
    expect(pyFloatRepr(-0)).toBe("-0.0");
    expect(pyFloatRepr(Number.NaN)).toBe("NaN");
    expect(pyFloatRepr(Infinity)).toBe("Infinity");
    expect(pyFloatRepr(-Infinity)).toBe("-Infinity");
  });
});

describe("compareCodePoints", () => {
  it("orders BMP before astral where UTF-16 would not", () => {
    expect(compareCodePoints("\uFFFD", "\u{1F600}")).toBeLessThan(0);
    expect(compareCodePoints("a", "a")).toBe(0);
    expect(compareCodePoints("ab", "a")).toBeGreaterThan(0);
  });
});

describe("pyStr", () => {
  it("formats the values urlencode can meet", () => {
    expect(pyStr("x")).toBe("x");
    expect(pyStr(443)).toBe("443");
    expect(pyStr(1.5)).toBe("1.5");
    expect(pyStr(true)).toBe("True");
    expect(pyStr(false)).toBe("False");
    expect(pyStr(null)).toBe("None");
    expect(pyStr(undefined)).toBe("None");
  });
});
