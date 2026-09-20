/**
 * Admin endpoints for nodes: CRUD, config, runtime pane, introspection,
 * status.
 *
 * WHY a separate router: nodes are the fleet's primary resource; config
 * parsing and the runtime pane hang off them. All paths sit under
 * `/api/admin/` (the route group from AGENTS.md); Cloudflare Access is the
 * actual authentication. No SQL and no business rules live here —
 * endpoints translate between HTTP and the service layer.
 */

import { Hono } from "hono";

import * as db from "../db";
import { ApiError, NodeCreate, NodeUpdate, parseJsonBody, parseJsonObject } from "../models";
import { inboundSummaries, outboundSummaries } from "../services/config_service";
import * as nodeService from "../services/node_service";
import * as nodeStateService from "../services/node_state_service";
import * as nodeTokenService from "../services/node_token_service";
import * as renderService from "../services/render_service";

export const adminNodes = new Hono<{ Bindings: Env }>();

/**
 * WHAT: return the node row or throw 404.
 *
 * WHY a helper: every node-scoped endpoint starts with the same lookup, and
 * a missing node must be a 404 everywhere — one place keeps that honest.
 */
async function nodeOr404(env: Env, nodeId: string): Promise<db.NodeRow> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  return node;
}

/**
 * WHAT: return the node's authored config; 404 for a missing node or
 * config.
 *
 * WHY 404 (not 503): no config yet is the expected state of a fresh node —
 * the config page renders an empty state, matching the archived
 * GET /api/config convention.
 */
async function configOr404(
  env: Env,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const node = await nodeOr404(env, nodeId);
  if (node.config_json === null) {
    throw new ApiError(404, "config not found");
  }
  return node.config_json;
}

/**
 * WHAT: like `configOr404` but throws 503, matching the archived tag
 * endpoints.
 *
 * WHY 503 here: "zero inbounds" and "config missing" are different states,
 * and the checkbox lists must not render an empty list as if the admin's
 * config had no inbounds.
 */
async function configOr503(
  env: Env,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const node = await nodeOr404(env, nodeId);
  if (node.config_json === null) {
    throw new ApiError(503, "config not loaded for this node");
  }
  return node.config_json;
}

/** WHAT: return every node. */
adminNodes.get("/api/admin/nodes", async (c) => {
  return c.json(await nodeService.listNodesOut(c.env.DB));
});

/** WHAT: create a node; 409 when the id is already taken. */
adminNodes.post("/api/admin/nodes", async (c) => {
  const payload = await parseJsonBody(c.req.raw, NodeCreate);
  if ((await db.getNode(c.env.DB, payload.id)) !== null) {
    throw new ApiError(409, "node id already exists");
  }
  return c.json(await nodeService.createNode(c.env.DB, payload), 201);
});

/** WHAT: return one node; 404 when missing. */
adminNodes.get("/api/admin/nodes/:node_id", async (c) => {
  const node = await nodeService.getNodeOut(c.env.DB, c.req.param("node_id"));
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  return c.json(node);
});

/** WHAT: partially update a node's label/address (null stays unchanged). */
adminNodes.put("/api/admin/nodes/:node_id", async (c) => {
  const payload = await parseJsonBody(c.req.raw, NodeUpdate);
  const node = await nodeService.updateNode(
    c.env.DB,
    c.req.param("node_id"),
    payload,
  );
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  return c.json(node);
});

/**
 * WHAT: mint (or rotate) one node's bearer token; plaintext shown once.
 *
 * WHY re-POST rotates with immediate invalidation: the new hash replaces
 * the old in one statement, so there is exactly one valid token per node.
 * The admin copies the plaintext into `agent.toml` (mode 0600) — it is
 * never stored and never returned again.
 */
adminNodes.post("/api/admin/nodes/:node_id/token", async (c) => {
  const nodeId = c.req.param("node_id");
  if ((await db.getNode(c.env.DB, nodeId)) === null) {
    throw new ApiError(404, "node not found");
  }
  const token = nodeTokenService.mintToken();
  await db.setTokenHash(
    c.env.DB,
    nodeId,
    await nodeTokenService.tokenHash(token),
  );
  return c.json(
    {
      node_id: nodeId,
      token,
      created_at: nodeStateService.now(),
    },
    201,
    { "Cache-Control": "no-store" },
  );
});

/** WHAT: return the node's authored config, opaque and untouched. */
adminNodes.get("/api/admin/nodes/:node_id/config", async (c) => {
  return c.json(await configOr404(c.env, c.req.param("node_id")));
});

/**
 * WHAT: replace the node's opaque config; agents converge on next
 * heartbeat.
 *
 * WHY PUT instead of the archived POST: replacing the whole document is
 * idempotent, so a retried request can never double-apply. The body is a
 * plain object because the config is opaque; non-object or malformed JSON
 * bodies are rejected as 422. Pre-qualified local tags are rejected without
 * saving.
 */
adminNodes.put("/api/admin/nodes/:node_id/config", async (c) => {
  const nodeId = c.req.param("node_id");
  const payload = await parseJsonObject(c.req.raw);
  const [exists, errors] = await nodeService.saveConfig(
    c.env.DB,
    nodeId,
    payload,
  );
  if (!exists) {
    throw new ApiError(404, "node not found");
  }
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  return c.json({ message: "config updated" });
});

/**
 * WHAT: return the config the plane would serve this node right now.
 *
 * WHY a live render and not a file: the plane no longer writes runtime
 * files or runs Xray — the rendered artifact is computed on demand from
 * current database state, so this pane can never go stale. 404 when the
 * node has no renderable config yet.
 */
adminNodes.get("/api/admin/nodes/:node_id/config/runtime", async (c) => {
  const nodeId = c.req.param("node_id");
  await nodeOr404(c.env, nodeId);
  const [runtime, warnings] = await renderService.desiredConfig(c.env, nodeId);
  if (runtime === null) {
    throw new ApiError(404, "runtime config not found");
  }
  return c.json({
    config: runtime,
    hash: await renderService.configHash(runtime),
    warnings,
  });
});

/**
 * WHAT: return drift at a glance: desired vs applied hash plus liveness.
 *
 * WHY desired is computed live: it is a pure function of current database
 * state, so the view is always fresh. `in_sync` is true only when a
 * renderable config exists and the node reported that exact hash — the
 * content-hash convergence property the agent loop rests on. 404 for an
 * unknown node.
 */
adminNodes.get("/api/admin/nodes/:node_id/sync", async (c) => {
  const state = await nodeStateService.syncState(
    c.env,
    c.req.param("node_id"),
  );
  if (state === null) {
    throw new ApiError(404, "node not found");
  }
  return c.json(state);
});

/** WHAT: return every inbound's tag/protocol/network/security summaries. */
adminNodes.get("/api/admin/nodes/:node_id/inbounds", async (c) => {
  const config = await configOr503(c.env, c.req.param("node_id"));
  return c.json(inboundSummaries(config));
});

/** WHAT: return every outbound's tag and protocol. */
adminNodes.get("/api/admin/nodes/:node_id/outbounds", async (c) => {
  const config = await configOr503(c.env, c.req.param("node_id"));
  return c.json(outboundSummaries(config));
});

/**
 * WHAT: return counts for the admin status bar.
 *
 * WHY only counts: the plane no longer runs Xray, so per-node health lives
 * on the sync endpoint — this stays a cheap composite snapshot.
 */
adminNodes.get("/api/admin/status", async (c) => {
  return c.json({
    node_count: (await db.listNodes(c.env.DB)).length,
    user_count: (await db.listUsers(c.env.DB)).length,
  });
});
