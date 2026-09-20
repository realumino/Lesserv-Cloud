/**
 * The pull contract's version.
 *
 * WHY the constant lives here: both repos implement this number, and the
 * agent's zero-code-change guarantee against the plane depends on it not
 * drifting silently. Bumping it means editing this module, the agent, and
 * docs/PROTOCOL.md together. The enroll/heartbeat/config/report endpoints
 * that serve it land in this module in TS rewrite Phase 5.
 */
export const PROTOCOL_VERSION = 1;
