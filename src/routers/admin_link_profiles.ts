/**
 * Admin endpoints for per-inbound link profiles.
 *
 * WHY a separate router: profiles are a fourth admin-managed resource with
 * their own identity and validation. They describe extra client views of an
 * inbound and never change the rendered runtime config. No SQL and no
 * profile rules live here.
 */

import { Hono } from "hono";

import * as db from "../db";
import {
  ApiError,
  LinkProfileIn,
  LinkProfileUpdate,
  parseJsonBody,
} from "../models";
import * as linkProfileService from "../services/link_profile_service";

export const adminLinkProfiles = new Hono<{ Bindings: Env }>();

const PREFIX = "/api/admin/nodes/:node_id/link-profiles";

/**
 * WHAT: return the node row or throw 404.
 *
 * WHY a helper: every profile endpoint starts with the same lookup, and a
 * missing node must be a 404 everywhere.
 */
async function nodeOr404(env: Env, nodeId: string): Promise<db.NodeRow> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  return node;
}

/** WHAT: return one node's link profiles in display order. */
adminLinkProfiles.get(PREFIX, async (c) => {
  const nodeId = c.req.param("node_id");
  await nodeOr404(c.env, nodeId);
  return c.json(await linkProfileService.listProfiles(c.env.DB, nodeId));
});

/** WHAT: create a profile attached to one of the node's authored inbounds. */
adminLinkProfiles.post(PREFIX, async (c) => {
  const nodeId = c.req.param("node_id");
  // WHY the body is parsed before the node lookup: FastAPI resolved the
  // Pydantic model before the handler ran, so a schema-invalid body beat a
  // 404 even for a missing node.
  const payload = await parseJsonBody(c.req.raw, LinkProfileIn);
  const node = await nodeOr404(c.env, nodeId);
  const errors = linkProfileService.validateCreate(node, payload);
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  if (
    (await linkProfileService.getProfile(c.env.DB, nodeId, payload.id)) !== null
  ) {
    throw new ApiError(409, "profile id already exists");
  }
  return c.json(
    await linkProfileService.createProfile(c.env.DB, nodeId, payload),
    201,
  );
});

/** WHAT: return one profile; 404 when the node or profile is missing. */
adminLinkProfiles.get(`${PREFIX}/:profile_id`, async (c) => {
  const nodeId = c.req.param("node_id");
  await nodeOr404(c.env, nodeId);
  const profile = await linkProfileService.getProfile(
    c.env.DB,
    nodeId,
    c.req.param("profile_id"),
  );
  if (profile === null) {
    throw new ApiError(404, "profile not found");
  }
  return c.json(profile);
});

/** WHAT: partially update a profile; a missing profile is a 404. */
adminLinkProfiles.put(`${PREFIX}/:profile_id`, async (c) => {
  const nodeId = c.req.param("node_id");
  // WHY the body is parsed first: see the POST handler above.
  const payload = await parseJsonBody(c.req.raw, LinkProfileUpdate);
  const node = await nodeOr404(c.env, nodeId);
  const errors = linkProfileService.validateUpdate(node, payload);
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  const profile = await linkProfileService.updateProfile(
    c.env.DB,
    nodeId,
    c.req.param("profile_id"),
    payload,
  );
  if (profile === null) {
    throw new ApiError(404, "profile not found");
  }
  return c.json(profile);
});

/** WHAT: delete a profile; a missing profile is a 404. */
adminLinkProfiles.delete(`${PREFIX}/:profile_id`, async (c) => {
  const nodeId = c.req.param("node_id");
  await nodeOr404(c.env, nodeId);
  if (
    !(await linkProfileService.deleteProfile(
      c.env.DB,
      nodeId,
      c.req.param("profile_id"),
    ))
  ) {
    throw new ApiError(404, "profile not found");
  }
  return c.body(null, 204);
});
