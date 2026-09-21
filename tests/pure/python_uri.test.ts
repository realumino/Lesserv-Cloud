/**
 * Python `urllib.parse` parity against Python-generated fixtures.
 *
 * WHY fixtures: share URIs are copied by users and pinned by tests; a
 * silent `!'()*` difference changes stored bytes. These vectors were
 * produced by the frozen Python implementation with the exact call shapes
 * `share_service` uses (`quote(s, safe="")`, `urlencode(..., quote_via=
 * quote, safe="")`).
 */

import { describe, expect, it } from "vitest";

import { pyQuote, pyUrlEncode } from "../../src/core/python_uri";
import fixture from "../fixtures/python_uri.json";

describe("pyQuote", () => {
  it("matches every Python-generated vector", () => {
    for (const vector of fixture.quote) {
      expect(pyQuote(vector.text, vector.safe), vector.name).toBe(vector.python);
    }
  });
});

describe("pyUrlEncode", () => {
  it("matches every Python-generated vector", () => {
    for (const vector of fixture.urlencode) {
      expect(pyUrlEncode(vector.params), vector.name).toBe(vector.python);
    }
  });
});

describe("label fragments", () => {
  it("percent-encodes link labels exactly like Python's quote", () => {
    for (const label of fixture.labels) {
      expect(pyQuote(label.remark)).toBe(label.python);
    }
  });
});
