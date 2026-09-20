/**
 * Admin endpoints for one node's REALITY keys: list and rotate.
 *
 * WHY a separate router: REALITY keys are the third resource (after nodes
 * and users). No SQL and no key logic live here — endpoints translate
 * between HTTP and the service layer, and never touch a private key: the
 * API returns only derived public keys.
 */

import { Hono } from "hono";

import * as db from "../db";
import { ApiError } from "../models";
import { realityInboundTags } from "../services/config_service";
import * as realityService from "../services/reality_service";

export const adminReality = new Hono<{ Bindings: Env }>();

/**
 * WHAT: return the node's authored config; 404 for a missing node or
 * config.
 *
 * WHY 404 (not 503): mirroring the archived reality router — a node without
 * a config has no REALITY inbounds to list, which is the same "nothing here
 * yet" state the config page renders as empty.
 */
async function realityConfigOr404(
  env: Env,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null || node.config_json === null) {
    throw new ApiError(404, "config not found");
  }
  return node.config_json;
}

/**
 * WHAT: list every REALITY inbound with its derived public key.
 *
 * WHY the private key is not returned: clients only ever need `pbk`; the
 * private key is visible where it is actually used (the runtime config
 * pane) and nowhere else.
 */
adminReality.get("/api/admin/nodes/:node_id/reality", async (c) => {
  const nodeId = c.req.param("node_id");
  const config = await realityConfigOr404(c.env, nodeId);
  return c.json({ keys: await realityService.listKeys(c.env, nodeId, config) });
});

/**
 * WHAT: rotate the key of every REALITY inbound.
 *
 * WHY one call for all: replacing the whole key set is the operator's
 * "start over" action. Nodes pick the new keys up on their next heartbeat —
 * rotation never pushes.
 */
adminReality.post("/api/admin/nodes/:node_id/reality/rotate", async (c) => {
  const nodeId = c.req.param("node_id");
  const config = await realityConfigOr404(c.env, nodeId);
  const tags = realityInboundTags(config);
  if (tags.length === 0) {
    throw new ApiError(404, "no REALITY inbounds in config");
  }
  for (const tag of tags) {
    await realityService.rotateKey(c.env, nodeId, tag);
  }
  return c.json({ rotated: tags });
});

/**
 * WHAT: rotate one REALITY inbound's key.
 *
 * WHY 404 for a non-REALITY tag: rotating a key that Xray never reads would
 * silently do nothing — the operator must learn the tag does not exist
 * instead of seeing success.
 */
adminReality.post(
  "/api/admin/nodes/:node_id/reality/:tag/rotate",
  async (c) => {
    const nodeId = c.req.param("node_id");
    const tag = c.req.param("tag");
    const config = await realityConfigOr404(c.env, nodeId);
    if (!realityInboundTags(config).includes(tag)) {
      throw new ApiError(404, `no REALITY inbound tagged '${tag}'`);
    }
    await realityService.rotateKey(c.env, nodeId, tag);
    return c.json({
      inbound: tag,
      public_key: await realityService.publicKey(c.env, nodeId, tag),
    });
  },
);
