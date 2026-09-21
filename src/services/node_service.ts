/**
 * Business rules for nodes: creation facts and config storage.
 *
 * WHY this layer exists: nodes are the fleet's primary resource. Their
 * rules are thin (the server stamps created_at, the config blob is opaque)
 * but they belong here, not in the router — routers do HTTP, services hold
 * rules, `db` holds SQL. Nothing is pushed after a write; agents converge
 * on their next heartbeat.
 */

import * as db from "../db";
import type { NodeCreate, NodeOut, NodeUpdate } from "../models";
import { localTagErrors } from "./qualify_service";

const REPORTED_MAX_LEN = 255;

/** WHAT: Unix seconds from the plane's clock (the time authority). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * WHAT: pick the reported address to store: the agent's claim, else the edge.
 *
 * WHY the agent's detected_ip wins: PROTOCOL.md defines it as the node's own
 * best guess at its public address. CF-Connecting-IP is the fallback for
 * agents that send none — the same fact, observed by the edge instead of
 * reported. The result is display data only, so an oversized or
 * whitespace-riddled value is skipped rather than sanitized into something
 * that looks trustworthy.
 */
export function reportedAddressFor(
  detectedIp: string | null | undefined,
  connectingIp: string | null | undefined,
): string | null {
  for (const candidate of [detectedIp, connectingIp]) {
    if (!candidate) {
      continue;
    }
    const value = candidate.trim();
    if (value && value.length <= REPORTED_MAX_LEN && !/\s/.test(value)) {
      return value;
    }
  }
  return null;
}

/**
 * WHAT: project a db node row to the NodeOut shape.
 *
 * WHY has_config: a list view must learn which nodes have a config without
 * fetching every config blob.
 */
export function toOut(node: db.NodeRow): NodeOut {
  return {
    id: node.id,
    label: node.label,
    address: node.address,
    reported_address: node.reported_address,
    created_at: node.created_at,
    has_config: node.config_json !== null,
  };
}

/**
 * WHAT: create a node row; no config and no token yet.
 *
 * WHY no token: the bearer token is minted separately (POST .../token) so
 * creation and credential issuance stay distinct operator actions — the
 * plaintext is shown once at mint time.
 */
export async function createNode(
  conn: D1Database,
  data: NodeCreate,
): Promise<NodeOut> {
  await db.createNode(conn, {
    id: data.id,
    label: data.label,
    address: data.address,
    created_at: nowSeconds(),
  });
  return toOut((await db.getNode(conn, data.id)) as db.NodeRow);
}

/**
 * WHAT: merge a partial update (null = unchanged); null when missing.
 *
 * WHY no sync here: label and address never change a rendered config — the
 * address only feeds share links, which are derived at request time.
 * Renaming a label can never break a client.
 */
export async function updateNode(
  conn: D1Database,
  nodeId: string,
  data: NodeUpdate,
): Promise<NodeOut | null> {
  const node = await db.getNode(conn, nodeId);
  if (node === null) {
    return null;
  }
  if (data.label !== null) {
    node.label = data.label;
  }
  if (data.address !== null) {
    node.address = data.address;
  }
  await db.replaceNode(conn, node);
  return toOut((await db.getNode(conn, nodeId)) as db.NodeRow);
}

/** WHAT: NodeOut-shaped object, or null when missing. */
export async function getNodeOut(
  conn: D1Database,
  nodeId: string,
): Promise<NodeOut | null> {
  const node = await db.getNode(conn, nodeId);
  return node !== null ? toOut(node) : null;
}

/** WHAT: every node in the NodeOut shape, id-ordered. */
export async function listNodesOut(conn: D1Database): Promise<NodeOut[]> {
  return (await db.listNodes(conn)).map(toOut);
}

/**
 * WHAT: replace a node's opaque config, when its tags are valid.
 *
 * WHY the object is stored untouched: the config is opaque — the plane
 * never validates or interprets its structure, except for tag-name
 * validation at paste time. The tuple separates a missing node from an
 * invalid payload: `[false, []]` means 404, `[true, errors]` means 422, and
 * `[true, []]` means the config was saved. Nothing is pushed: each node's
 * agent picks the new render up on its next heartbeat.
 */
export async function saveConfig(
  conn: D1Database,
  nodeId: string,
  payload: Record<string, unknown>,
): Promise<[boolean, string[]]> {
  const node = await db.getNode(conn, nodeId);
  if (node === null) {
    return [false, []];
  }
  const errors = localTagErrors(payload, nodeId);
  if (errors.length > 0) {
    return [true, errors];
  }
  await db.setNodeConfig(conn, nodeId, payload);
  return [true, []];
}
