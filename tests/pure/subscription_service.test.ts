/**
 * Pure tests for the subscription payload encoder.
 *
 * WHY these assertions matter: the base64 body is the subscription contract
 * — every client decodes it with the standard alphabet and expects a
 * newline-joined URI list. Alphabet, padding, join, and UTF-8 handling are
 * the observable bytes, so they are pinned here without a database.
 */

import { describe, expect, it } from "vitest";

import { encodeSubscription } from "../../src/services/subscription_service";

/** WHAT: decode standard base64 into a UTF-8 string (the client's view). */
function decode(body: string): string {
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

describe("encodeSubscription", () => {
  it("encodes an empty list as the empty string", () => {
    expect(encodeSubscription([])).toBe("");
  });

  it("encodes one URI with no newline", () => {
    const body = encodeSubscription(["vless://a@h:443?x=1#one"]);
    expect(decode(body)).toBe("vless://a@h:443?x=1#one");
  });

  it("joins URIs with newlines and no trailing newline", () => {
    const body = encodeSubscription(["vless://one", "vless://two"]);
    expect(decode(body)).toBe("vless://one\nvless://two");
  });

  it("uses the standard alphabet with padding", () => {
    const body = encodeSubscription(["vless://a", "vless://b"]);
    expect(body).not.toContain("-");
    expect(body).not.toContain("_");
    expect(body.endsWith("=") || body.length % 4 === 0).toBe(true);
  });

  it("encodes non-ASCII as UTF-8 instead of throwing", () => {
    // btoa would throw on this; TextEncoder must not.
    const body = encodeSubscription(["vless://u@exämple.com:443#日本"]);
    expect(decode(body)).toBe("vless://u@exämple.com:443#日本");
  });
});
