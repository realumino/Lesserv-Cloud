/**
 * The pure join behind the fleet view.
 *
 * WHY a separate function: the fleet page fetches the node list and then
 * one sync response per node, and a single failed sync must not blank the
 * whole table. Deciding what each row's state is — and what to do when a
 * sync is missing — is the only logic on the page worth testing without a
 * browser.
 */

import type { NodeOut, NodeSyncOut } from "../types";

/** The coarse state one fleet row shows. */
export type FleetState =
  | "in-sync"
  | "drifted"
  | "error"
  | "pending"
  | "no-config"
  | "unknown";

/** One fleet row: the node plus its sync response (null when unavailable). */
export interface FleetRow {
  node: NodeOut;
  sync: NodeSyncOut | null;
  state: FleetState;
}

/** The display text for each state (shared by the fleet table and the node header). */
export const STATE_LABEL: Record<FleetState, string> = {
  "in-sync": "in sync",
  drifted: "drifted",
  error: "error",
  pending: "pending",
  "no-config": "no config",
  unknown: "—",
};

/** The badge tone for each state. */
export const STATE_TONE: Record<FleetState, "ok" | "warn" | "bad" | "idle"> = {
  "in-sync": "ok",
  drifted: "warn",
  error: "bad",
  pending: "idle",
  "no-config": "idle",
  unknown: "idle",
};

/** Reduce one sync response to a display state (null sync = unknown). */
export function fleetState(sync: NodeSyncOut | null): FleetState {
  if (!sync) {
    return "unknown";
  }
  if (sync.desired_hash === null) {
    return "no-config";
  }
  if (sync.in_sync) {
    return "in-sync";
  }
  if (sync.last_error) {
    return "error";
  }
  if (sync.applied_hash === null) {
    return "pending";
  }
  return "drifted";
}

/** Join the node list with the per-node sync map, preserving node order. */
export function fleetRows(
  nodes: NodeOut[],
  syncByNode: Record<string, NodeSyncOut | null>,
): FleetRow[] {
  return nodes.map((node) => {
    const sync = syncByNode[node.id] ?? null;
    return { node, sync, state: fleetState(sync) };
  });
}
