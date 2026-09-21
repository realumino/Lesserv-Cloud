/**
 * PROTOCOL.md is frozen at protocol 1 for the deployed plane.
 *
 * Why a pin and not a docstring: both repos implement this number, and the
 * agent's zero-code-change proof against the plane depends on it not
 * drifting silently. Bumping it means editing this test, the agent, and
 * docs/PROTOCOL.md together.
 */

import { expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../../src/routers/node";

it("serves protocol version 1", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
