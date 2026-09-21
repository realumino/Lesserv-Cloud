/**
 * Admin endpoints for users: CRUD with per-node access, and share links.
 *
 * WHY a separate router: users are global identity; their per-node access
 * is the payload's nested map, and the links endpoint aggregates across
 * every node the user can use. No SQL and no business rules live here.
 */

import { Hono } from "hono";

import * as db from "../db";
import {
  ApiError,
  parseJsonBody,
  SubTokenOut,
  UserCreate,
  UserUpdate,
} from "../models";
import * as linkService from "../services/link_service";
import * as userService from "../services/user_service";

export const adminUsers = new Hono<{ Bindings: Env }>();

/**
 * WHAT: return the listed node ids that do not exist.
 *
 * WHY the router does this and not the service: a membership payload
 * referencing a missing node must fail before anything is written, and the
 * router is the boundary that turns that into a 404. The service trusts its
 * caller to have checked.
 */
async function unknownNodeIds(
  env: Env,
  nodeIds: string[],
): Promise<string[]> {
  const unknown: string[] = [];
  for (const nodeId of nodeIds) {
    if ((await db.getNode(env.DB, nodeId)) === null) {
      unknown.push(nodeId);
    }
  }
  return unknown;
}

/** WHAT: return every user with their per-node access. */
adminUsers.get("/api/admin/users", async (c) => {
  return c.json(await userService.listUsersWithAccess(c.env.DB));
});

/** WHAT: create a user; 409 when taken, 404 for an unknown node in access. */
adminUsers.post("/api/admin/users", async (c) => {
  const payload = await parseJsonBody(c.req.raw, UserCreate);
  if ((await db.getUser(c.env.DB, payload.username)) !== null) {
    throw new ApiError(409, "username already exists");
  }
  const unknown = await unknownNodeIds(c.env, Object.keys(payload.access));
  if (unknown.length > 0) {
    throw new ApiError(404, `node '${unknown[0]}' not found`);
  }
  return c.json(await userService.createUser(c.env.DB, payload), 201);
});

/** WHAT: return one user with nested access; 404 when missing. */
adminUsers.get("/api/admin/users/:username", async (c) => {
  const user = await userService.getUserWithAccess(
    c.env.DB,
    c.req.param("username"),
  );
  if (user === null) {
    throw new ApiError(404, "user not found");
  }
  return c.json(user);
});

/** WHAT: partially update a user; a provided access map replaces membership. */
adminUsers.put("/api/admin/users/:username", async (c) => {
  const username = c.req.param("username");
  const payload = await parseJsonBody(c.req.raw, UserUpdate);
  if (payload.access !== null) {
    const unknown = await unknownNodeIds(c.env, Object.keys(payload.access));
    if (unknown.length > 0) {
      throw new ApiError(404, `node '${unknown[0]}' not found`);
    }
  }
  const user = await userService.updateUser(c.env.DB, username, payload);
  if (user === null) {
    throw new ApiError(404, "user not found");
  }
  return c.json(user);
});

/** WHAT: delete a user and their access rows; 404 when missing. */
adminUsers.delete("/api/admin/users/:username", async (c) => {
  if (!(await userService.deleteUser(c.env.DB, c.req.param("username")))) {
    throw new ApiError(404, "user not found");
  }
  return c.body(null, 204);
});

/**
 * WHAT: mint (or rotate) one user's subscription token; plaintext shown in
 * this response.
 *
 * WHY rotation replaces in one statement: the old URL dies the moment the
 * new token is stored, so a leaked URL is fixed with one POST. Same posture
 * as the node token mint, but the value is displayed (never hashed) because
 * the subscription URL is the product — it must stay re-displayable — and
 * its 256 bits of entropy make the plaintext column safe (docs/M6-PLAN.md).
 */
adminUsers.post("/api/admin/users/:username/sub-token", async (c) => {
  const token = await userService.rotateSubToken(
    c.env.DB,
    c.req.param("username"),
  );
  if (token === null) {
    throw new ApiError(404, "user not found");
  }
  const body = token as unknown as SubTokenOut;
  return c.json(body, 201, { "Cache-Control": "no-store" });
});

/**
 * WHAT: return every share link the user is entitled to, across nodes.
 *
 * WHY read-only: links are a view over existing config, access, key, and
 * profile rows; generating them must not restart Xray or write to the
 * database. The aggregation (access pairs, skip rules, per-node collection)
 * lives in `link_service.userLinks`, shared with the M6 subscription body —
 * two presentations, one list. This route adds only the archived status
 * codes: 404 unknown user, 503 when the user has access but no node config
 * to build from, 409 when no node has a usable address. Nodes without a
 * config are skipped with a warning.
 */
adminUsers.get("/api/admin/users/:username/links", async (c) => {
  const username = c.req.param("username");
  const user = await db.getUser(c.env.DB, username);
  if (user === null) {
    throw new ApiError(404, "user not found");
  }
  const aggregated = await linkService.userLinks(c.env, username, user.status);
  if (aggregated.accessCount > 0 && aggregated.withConfigCount === 0) {
    throw new ApiError(503, "no node config to build links from");
  }
  if (aggregated.withConfigCount > 0 && aggregated.addressableCount === 0) {
    throw new ApiError(409, "no node has a usable address");
  }
  return c.json({
    username,
    links: aggregated.links,
    warnings: aggregated.warnings,
  });
});
