/**
 * Admin endpoints for users: CRUD with per-node access, and share links.
 *
 * WHY a separate router: users are global identity; their per-node access
 * is the payload's nested map, and the links endpoint aggregates across
 * every node the user can use. No SQL and no business rules live here.
 */

import { Hono } from "hono";

import * as db from "../db";
import { ApiError, parseJsonBody, UserCreate, UserUpdate } from "../models";
import * as linkService from "../services/link_service";
import { hasUsableAddress, type ShareLink } from "../services/share_service";
import * as userService from "../services/user_service";

export const adminUsers = new Hono<{ Bindings: Env }>();

/** WHAT: one generated link after its owning node id is stamped on. */
type LinkOut = ShareLink & { node: string };

/** WHAT: an access row paired with the node it points at (null if deleted). */
type AccessPair = [db.AccessRow, db.NodeRow | null];

/** WHAT: a config-bearing entry ready for link generation. */
type LinkEntry = [db.AccessRow, db.NodeRow, db.LinkProfileRow[]];

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

/** WHAT: return one user's access rows paired with their node rows. */
async function accessPairs(env: Env, username: string): Promise<AccessPair[]> {
  const pairs: AccessPair[] = [];
  for (const row of await db.listAccessForUser(env.DB, username)) {
    pairs.push([row, await db.getNode(env.DB, row.node_id)]);
  }
  return pairs;
}

/**
 * WHAT: separate configless-node warnings from config-bearing pairs.
 *
 * WHY two outputs: the skipped ids become warnings and the rest flow into
 * link generation, so the router never has to re-walk the pairs. The
 * warning names the node from the access row, so a dangling access row
 * cannot crash the list (the Python version reached through the null node).
 */
function splitConfigPairs(pairs: AccessPair[]): [string[], [db.AccessRow, db.NodeRow][]] {
  const skipped: string[] = [];
  const withConfig: [db.AccessRow, db.NodeRow][] = [];
  for (const [row, node] of pairs) {
    if (node === null || node.config_json === null) {
      skipped.push(`${row.node_id}: has no config; skipped`);
      continue;
    }
    withConfig.push([row, node]);
  }
  return [skipped, withConfig];
}

/**
 * WHAT: return config-bearing entries that can produce at least one link.
 *
 * WHY the profile addresses are part of the check: a profile may supply the
 * client-facing address even when the node has none, so an entry is
 * addressable if any of its views is.
 */
async function addressableEntries(
  env: Env,
  withConfig: [db.AccessRow, db.NodeRow][],
): Promise<LinkEntry[]> {
  const entries: LinkEntry[] = [];
  for (const [row, node] of withConfig) {
    const profiles = await db.listLinkProfiles(env.DB, node.id);
    const profileAddresses = profiles.map(
      (profile) => profile.overrides["address"],
    );
    if (
      hasUsableAddress(
        node.config_json as Record<string, unknown>,
        node.address,
        profileAddresses,
      )
    ) {
      entries.push([row, node, profiles]);
    }
  }
  return entries;
}

/** WHAT: warn for config-bearing nodes that cannot produce a usable address. */
function unaddressableWarnings(
  withConfig: [db.AccessRow, db.NodeRow][],
  entries: LinkEntry[],
): string[] {
  const addressable = new Set(entries.map(([, node]) => node.id));
  return withConfig
    .filter(([, node]) => !addressable.has(node.id))
    .map(([, node]) => `${node.id}: has no usable address`);
}

/**
 * WHAT: build every link across the user's config-bearing nodes.
 *
 * WHY the node id rides on each link: a subscription (M6) joins links from
 * several nodes, and each link must carry its own node's address and key
 * derivation. Warnings are prefixed with the node id so a multi-node list
 * stays readable.
 */
async function collectLinks(
  env: Env,
  userStatus: string,
  entries: LinkEntry[],
): Promise<[LinkOut[], string[]]> {
  const links: LinkOut[] = [];
  const warnings: string[] = [];
  for (const [row, node, profiles] of entries) {
    const [nodeLinks, nodeWarnings] = await linkService.nodeLinks(
      env,
      node,
      row,
      userStatus,
      profiles,
    );
    for (const link of nodeLinks) {
      links.push({ ...link, node: node.id });
    }
    warnings.push(...nodeWarnings.map((warning) => `${node.id}: ${warning}`));
  }
  return [links, warnings];
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
 * WHAT: return every share link the user is entitled to, across nodes.
 *
 * WHY read-only: links are a view over existing config, access, key, and
 * profile rows; generating them must not restart Xray or write to the
 * database. The archived status codes carry over: 404 unknown user, 503
 * when the user has access but no node config to build from, 409 when no
 * node has a usable address. Nodes without a config are skipped with a
 * warning.
 */
adminUsers.get("/api/admin/users/:username/links", async (c) => {
  const username = c.req.param("username");
  const user = await db.getUser(c.env.DB, username);
  if (user === null) {
    throw new ApiError(404, "user not found");
  }
  const pairs = await accessPairs(c.env, username);
  const [warnings, withConfig] = splitConfigPairs(pairs);
  if (pairs.length > 0 && withConfig.length === 0) {
    throw new ApiError(503, "no node config to build links from");
  }
  const entries = await addressableEntries(c.env, withConfig);
  if (withConfig.length > 0 && entries.length === 0) {
    throw new ApiError(409, "no node has a usable address");
  }
  const [links, moreWarnings] = await collectLinks(c.env, user.status, entries);
  warnings.push(...moreWarnings);
  warnings.push(...unaddressableWarnings(withConfig, entries));
  return c.json({ username, links, warnings });
});
