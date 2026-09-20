/**
 * Rules for node liveness, apply reports, and drift display.
 *
 * WHY this layer exists: heartbeats must be cheap (no write on every poll),
 * reports must translate stage+ok into stored health without touching the
 * applied hash on failure, and the admin sync view must combine a live
 * render with stored facts. Routers do HTTP; `db` does SQL; the decisions
 * live here. Pure helpers stay synchronous so they unit-test without a
 * database; the drift view is async because it renders live.
 */

import * as db from "../db";
import type { HeartbeatIn, NodeSyncOut, ReportIn } from "../models";
import { configHash, desiredConfig } from "./render_service";

export const HEARTBEAT_STALE_AFTER = 60;
export const SUCCESS_STAGES = ["applied", "started"] as const;

/** WHAT: the liveness columns one heartbeat or report wants stored. */
export type LivenessValues = {
  last_seen: number;
  health: string | null;
  agent_version: string | null;
  xray_version: string | null;
  last_error: string | null;
  applied_hash: string | null;
};

/** WHAT: the stored columns these rules compare against (no config, no id). */
type LivenessRow = Pick<
  db.NodeRow,
  | "last_seen"
  | "health"
  | "agent_version"
  | "xray_version"
  | "last_error"
  | "applied_hash"
>;

/** WHAT: Unix seconds from the plane's clock (the time authority). */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * WHAT: compute the liveness columns one heartbeat wants stored.
 *
 * WHY applied_hash is adopted but versions/health/last_error are preserved:
 * the dashboard shows "as last reported", and the heartbeat is the freshest
 * claim of what runs — but versions arrive on enroll (the heartbeat carries
 * none) and health is a diagnosis that only a report may set or clear.
 */
export function heartbeatValues(
  node: LivenessRow,
  payload: HeartbeatIn,
  at: number,
): LivenessValues {
  return {
    last_seen: at,
    health: node.health,
    agent_version: node.agent_version,
    xray_version: node.xray_version,
    last_error: node.last_error,
    applied_hash: payload.applied_hash,
  };
}

/**
 * WHAT: return true when a heartbeat's values deserve a database write.
 *
 * WHY the 60s staleness rule: at fleet scale an unconditional write per 30s
 * poll is hundreds of writes a minute for no information gain. A write
 * happens only when liveness went stale or a fact actually changed —
 * heartbeats stay cheap.
 */
export function shouldTouch(
  node: LivenessRow,
  values: LivenessValues,
  at: number,
): boolean {
  if (node.last_seen === null) {
    return true;
  }
  if (at - node.last_seen > HEARTBEAT_STALE_AFTER) {
    return true;
  }
  const facts = [
    "health",
    "agent_version",
    "xray_version",
    "last_error",
    "applied_hash",
  ] as const;
  for (const key of facts) {
    if (values[key] !== node[key]) {
      return true;
    }
  }
  return false;
}

/**
 * WHAT: compute the liveness columns one apply report wants stored.
 *
 * WHY a failed apply never moves applied_hash: the node rolled back to
 * last-good, so what runs is still the old hash — recording the failed one
 * would hide the drift the dashboard must show. Success on
 * `applied`/`started` adopts the hash and clears the error; success on
 * earlier stages only clears nothing and moves nothing.
 */
export function reportValues(
  node: LivenessRow,
  payload: ReportIn,
  at: number,
): LivenessValues {
  const values: LivenessValues = {
    last_seen: at,
    health: node.health,
    agent_version: node.agent_version,
    xray_version: node.xray_version,
    last_error: node.last_error,
    applied_hash: node.applied_hash,
  };
  const succeeded =
    payload.ok && (SUCCESS_STAGES as readonly string[]).includes(payload.stage);
  if (succeeded) {
    values.applied_hash = payload.hash;
    values.last_error = null;
    values.health = "ok";
  } else if (!payload.ok) {
    values.last_error = payload.error;
    values.health = `error:${payload.stage}`;
  }
  return values;
}

/** WHAT: write precomputed liveness values through the single db statement. */
export async function touchFromValues(
  conn: D1Database,
  nodeId: string,
  values: LivenessValues,
): Promise<void> {
  await db.touchNode(
    conn,
    nodeId,
    values.last_seen,
    values.health,
    values.agent_version,
    values.xray_version,
    values.last_error,
    values.applied_hash,
  );
}

/**
 * WHAT: return `[hex hash | null, warnings]` of one node's desired config.
 *
 * WHY None instead of raising: no config and malformed config are states
 * the agent must ride out calmly — the heartbeat carries null and the agent
 * changes nothing.
 */
export async function desiredHash(
  env: Env,
  nodeId: string,
): Promise<[string | null, string[]]> {
  const [runtime, warnings] = await desiredConfig(env, nodeId);
  if (runtime === null) {
    return [null, warnings];
  }
  return [await configHash(runtime), warnings];
}

/**
 * WHAT: return the NodeSyncOut-shaped drift view for one node, or null.
 *
 * WHY the render happens here: drift is desired-vs-applied, and desired is
 * a pure function of current database state — computing it live means the
 * view can never go stale the way a stored column would.
 */
export async function syncState(
  env: Env,
  nodeId: string,
): Promise<NodeSyncOut | null> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null) {
    return null;
  }
  const [wanted, warnings] = await desiredHash(env, nodeId);
  return {
    node_id: nodeId,
    state: node.last_seen !== null ? "active" : "pending",
    desired_hash: wanted,
    applied_hash: node.applied_hash,
    in_sync: wanted !== null && node.applied_hash === wanted,
    last_seen: node.last_seen,
    health: node.health,
    agent_version: node.agent_version,
    xray_version: node.xray_version,
    last_error: node.last_error,
    warnings,
  };
}
