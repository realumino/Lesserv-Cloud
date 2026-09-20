/** Pin the display formatting shared by every page. */

import { describe, expect, it } from "vitest";

import {
  fmtExpire,
  fmtTimestamp,
  fromLocalInput,
  relativeTime,
  shortHash,
  toLocalInput,
} from "./format";

describe("shortHash", () => {
  it("shortens long hashes and passes short ones through", () => {
    expect(shortHash("abcdef1234567890")).toBe("abcdef12…");
    expect(shortHash("abc")).toBe("abc");
    expect(shortHash(null)).toBe("—");
  });
});

describe("fmtExpire", () => {
  it("distinguishes unset, never, and a real date", () => {
    expect(fmtExpire(null)).toBe("—");
    expect(fmtExpire(0)).toBe("never");
    expect(fmtExpire(1758000000)).not.toBe("—");
  });
});

describe("fmtTimestamp", () => {
  it("renders zero and null as an em dash", () => {
    expect(fmtTimestamp(null)).toBe("—");
    expect(fmtTimestamp(0)).toBe("—");
    expect(fmtTimestamp(1758000000)).not.toBe("—");
  });
});

describe("datetime-local helpers", () => {
  it("round-trips a minute-aligned timestamp through local input format", () => {
    const timestamp = 1_758_000_000; // divisible by 60, so minute precision holds
    const input = toLocalInput(timestamp);

    expect(input).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(input)).toBe(timestamp);
  });
});

describe("relativeTime", () => {
  const now = 1_758_000_000_000;

  it("buckets seconds, minutes, hours, and days", () => {
    expect(relativeTime(now / 1000 - 12, now)).toBe("12s ago");
    expect(relativeTime(now / 1000 - 3 * 60, now)).toBe("3m ago");
    expect(relativeTime(now / 1000 - 5 * 3600, now)).toBe("5h ago");
    expect(relativeTime(now / 1000 - 2 * 86400, now)).toBe("2d ago");
  });

  it("treats a missing timestamp as never and clock skew as just now", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(now / 1000 + 5, now)).toBe("just now");
  });
});
