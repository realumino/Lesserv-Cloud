/**
 * Agent-facing endpoints: the PROTOCOL.md v1 pull contract.
 *
 * WHY a separate router: these are the only endpoints that authenticate by
 * node bearer token instead of (from M4) Cloudflare Access, and every one
 * is scoped to the calling node — a node must never read another node's
 * data. No SQL and no liveness rules live here; endpoints translate
 * between HTTP and the service layer.
 */

import { Hono } from "hono";

import * as db from "../db";
import {
  ApiError,
  EnrollIn,
  HeartbeatIn,
  parseJsonBody,
  ReportIn,
  StatsIn,
} from "../models";
import * as nodeService from "../services/node_service";
import * as nodeStateService from "../services/node_state_service";
import * as nodeTokenService from "../services/node_token_service";
import * as renderService from "../services/render_service";

/**
 * The pull contract's version.
 *
 * WHY the constant lives here: both repos implement this number, and the
 * agent's zero-code-change guarantee against the plane depends on it not
 * drifting silently. Bumping it means editing this module, the agent, and
 * docs/PROTOCOL.md together.
 */
export const PROTOCOL_VERSION = 1;

export const nodeApi = new Hono<{ Bindings: Env }>();

/**
 * WHAT: return the authenticated node row, or throw 401.
 *
 * WHY every mismatch looks identical: a missing header, an unknown id, a
 * node with no minted token, and a wrong token must be indistinguishable
 * from the outside, and nothing about the attempt is logged. The node id
 * selects the row (so a valid request can name the node); the bearer token
 * proves it. The split on the first space mirrors Python's
 * `authorization.partition(" ")`, so `Bearer  tok` presents `" tok"` and
 * fails, exactly as it did before the port.
 */
async function requireNode(env: Env, request: Request): Promise<db.NodeRow> {
  const authorization = request.headers.get("Authorization") ?? "";
  const headerNodeId = request.headers.get("X-Lesserv-Node") ?? "";
  const spaceIndex = authorization.indexOf(" ");
  const scheme =
    spaceIndex < 0 ? authorization : authorization.slice(0, spaceIndex);
  const presented = spaceIndex < 0 ? "" : authorization.slice(spaceIndex + 1);
  const node = headerNodeId ? await db.getNode(env.DB, headerNodeId) : null;
  if (
    node === null ||
    scheme.toLowerCase() !== "bearer" ||
    !presented ||
    !(await nodeTokenService.verifyToken(node.token_hash, presented))
  ) {
    throw new ApiError(401, "invalid node credentials");
  }
  return node;
}

/**
 * WHAT: reject a protocol version the plane cannot honor, explicitly.
 *
 * WHY 400 and not 422: the body parsed fine — the plane is refusing to
 * reinterpret a version it does not understand, per PROTOCOL.md. The
 * agent's correct response is to keep serving its current config.
 */
function assertProtocol(payload: { protocol: number }): void {
  if (payload.protocol !== PROTOCOL_VERSION) {
    throw new ApiError(400, `unsupported protocol ${payload.protocol}`);
  }
}

/**
 * WHAT: first contact — record versions/liveness, return metadata + hash.
 *
 * WHY idempotent: re-running enroll (e.g. after editing agent.toml) is the
 * correct recovery action — it records the same facts and returns the same
 * shape, converging rather than duplicating anything.
 *
 * WHY the reported address is recorded here: enroll is the one moment the
 * node states its own public address. It is display data for the admin's
 * fleet view, never a share-link host — that stays the admin-set domain in
 * `nodes.address`.
 */
nodeApi.post("/api/node/enroll", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, EnrollIn);
  assertProtocol(payload);
  const reported = nodeService.reportedAddressFor(
    payload.detected_ip,
    c.req.header("cf-connecting-ip"),
  );
  if (reported && reported !== node.reported_address) {
    await db.setReportedAddress(c.env.DB, node.id, reported);
  }
  const at = nodeStateService.now();
  await nodeStateService.touchFromValues(c.env.DB, node.id, {
    last_seen: at,
    health: node.health,
    agent_version: payload.agent_version || node.agent_version,
    xray_version: payload.xray_version || node.xray_version,
    last_error: node.last_error,
    applied_hash: node.applied_hash,
  });
  const [wanted] = await nodeStateService.desiredHash(c.env, node.id);
  const fresh = (await db.getNode(c.env.DB, node.id)) as db.NodeRow;
  return c.json({
    id: fresh.id,
    label: fresh.label,
    address: fresh.address,
    state: "active",
    desired_hash: wanted,
  });
});

/**
 * WHAT: the 30s poll — compare hashes cheaply, write liveness rarely.
 *
 * WHY the write is conditional: heartbeats are the hottest endpoint in the
 * system and almost always carry no news — persisting every one would be
 * hundreds of pointless writes a minute at fleet scale.
 */
nodeApi.post("/api/node/heartbeat", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, HeartbeatIn);
  assertProtocol(payload);
  const at = nodeStateService.now();
  const [wanted] = await nodeStateService.desiredHash(c.env, node.id);
  const values = nodeStateService.heartbeatValues(node, payload, at);
  if (nodeStateService.shouldTouch(node, values, at)) {
    await nodeStateService.touchFromValues(c.env.DB, node.id, values);
  }
  return c.json({ desired_hash: wanted, actions: [] });
});

/**
 * WHAT: return this node's fully rendered runtime config, exactly as run.
 *
 * WHY `?hash=` returns 409 on mismatch: the agent asks for the hash its
 * heartbeat named, and if the plane moved on since, serving current bytes
 * would let the agent record the wrong hash as applied — so the agent
 * re-heartbeats instead. WHY no-store: the body carries every UUID plus the
 * REALITY private key — it must never sit in a cache. The agent never
 * transforms, merges, or second-guesses it.
 */
nodeApi.get("/api/node/config", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const [runtime] = await renderService.desiredConfig(c.env, node.id);
  if (runtime === null) {
    throw new ApiError(404, "no renderable config");
  }
  const wanted = await renderService.configHash(runtime);
  const presented = c.req.query("hash");
  if (presented !== undefined && presented !== wanted) {
    throw new ApiError(409, {
      message: "desired config moved; re-heartbeat",
      desired_hash: wanted,
    });
  }
  return c.json(
    { hash: wanted, config: runtime },
    200,
    { "Cache-Control": "no-store" },
  );
});

/**
 * WHAT: record one apply attempt; failures keep the old applied hash.
 *
 * WHY a missing report is not a problem: the next heartbeat re-syncs
 * reality anyway — reports are for diagnosis and the audit trail, not for
 * correctness. Duplicate reports are safe by construction.
 */
nodeApi.post("/api/node/report", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, ReportIn);
  assertProtocol(payload);
  const values = nodeStateService.reportValues(
    node,
    payload,
    nodeStateService.now(),
  );
  await nodeStateService.touchFromValues(c.env.DB, node.id, values);
  return c.json({});
});

/**
 * WHAT: accept absolute traffic counters; validate now, accumulate in M7.
 *
 * WHY the counters are not stored: `node_stats` and the max(0, new-old)
 * accumulation do not exist until M7 — but the agent ships
 * absolute-plus-boot-id from v1 so history can start accumulating the day
 * the plane learns to keep it.
 */
nodeApi.post("/api/node/stats", async (c) => {
  await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, StatsIn);
  assertProtocol(payload);
  return c.json({ accepted: Object.keys(payload.counters).length });
});
