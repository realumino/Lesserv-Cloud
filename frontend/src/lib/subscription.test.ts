/**
 * Pin the subscription URL construction.
 *
 * WHY it matters: this URL is handed to end users and imported into client
 * apps; a malformed one (trailing slash, "null" token) breaks a real
 * person's subscription silently.
 */

import { describe, expect, it } from "vitest";

import { subscriptionUrl } from "./subscription";

describe("subscriptionUrl", () => {
  it("joins origin and token", () => {
    expect(subscriptionUrl("https://cp.example.org", "abc")).toBe(
      "https://cp.example.org/sub/abc",
    );
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(subscriptionUrl("https://cp.example.org/", "abc")).toBe(
      "https://cp.example.org/sub/abc",
    );
  });

  it("keeps localhost origins working for dev", () => {
    expect(subscriptionUrl("http://localhost:5173", "abc")).toBe(
      "http://localhost:5173/sub/abc",
    );
  });

  it("returns null for a missing token instead of a broken URL", () => {
    expect(subscriptionUrl("https://cp.example.org", null)).toBeNull();
    expect(subscriptionUrl("https://cp.example.org", "")).toBeNull();
  });
});
