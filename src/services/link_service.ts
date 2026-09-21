/**
 * Generate one node's qualified share links from stored state.
 *
 * WHY this layer exists: links combine four node-scoped inputs — access,
 * authored config, REALITY keys, and profiles — and all four are stored
 * local. This module qualifies them consistently, builds readable labels,
 * and delegates URI assembly to the pure share service. It never writes,
 * renders, or syncs: link generation is read-only.
 */

import { compareCodePoints } from "../core/python_json";
import * as db from "../db";
import { inboundSummaries } from "./config_service";
import { prettyTag } from "./labels";
import {
  isQualifiedInboundTag,
  isQualifiedOutboundTag,
  qualifyConfig,
  qualifyKeys,
  qualifyProfiles,
  qualifyUsers,
} from "./qualify_service";
import { keyMap } from "./reality_service";
import { userShape } from "./render_service";
import {
  hasUsableAddress,
  type LinkUser,
  linksForUser,
  type ShareLink,
} from "./share_service";

/** WHAT: a JSON object carrying authored or qualified config data. */
type Dict = Record<string, unknown>;

/**
 * WHAT: one generated link after its owning node id is stamped on.
 *
 * WHY the node id rides on each link: a subscription (M6) joins links from
 * several nodes, and each link must carry its own node's address and key
 * derivation. Warnings are prefixed with the node id so a multi-node list
 * stays readable.
 */
export type LinkOut = ShareLink & { node: string };

/** WHAT: an access row paired with the node it points at (null if deleted). */
type AccessPair = [db.AccessRow, db.NodeRow | null];

/** WHAT: a config-bearing entry ready for link generation. */
type LinkEntry = [db.AccessRow, db.NodeRow, db.LinkProfileRow[]];

/**
 * WHAT: everything the two link presentations (admin JSON, subscription
 * body) need from one aggregation pass.
 *
 * WHY counts instead of pre-thrown errors: the admin route maps them to
 * 503/409 and the subscription route ignores them — the aggregation itself
 * must not know HTTP.
 */
export type UserLinks = {
  links: LinkOut[];
  warnings: string[];
  /** Access rows on the user, regardless of node state. */
  accessCount: number;
  /** Rows whose node exists and has a config. */
  withConfigCount: number;
  /** Config-bearing nodes that can produce at least one link. */
  addressableCount: number;
};

/**
 * WHAT: return true only for a non-empty object (not an array).
 *
 * WHY: config data is arbitrary JSON; structural probes need a TS
 * counterpart to Python's `isinstance(x, dict)`.
 */
function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** WHAT: remove this node's inbound suffix when present for display naming. */
function baseInboundTag(tag: string, nodeId: string): string {
  if (isQualifiedInboundTag(tag, nodeId)) {
    return tag.slice(0, -(nodeId.length + 1));
  }
  return tag;
}

/** WHAT: remove this node's outbound prefix when present for display naming. */
function baseOutboundTag(tag: string, nodeId: string): string {
  if (isQualifiedOutboundTag(tag, nodeId)) {
    return tag.slice(nodeId.length + 1);
  }
  return tag;
}

/**
 * WHAT: map qualified tags to prettified local names for readable labels.
 *
 * WHY the isinstance checks: a malformed config's entries may not be dicts
 * or may lack a string tag; naming simply skips them, exactly like Python.
 */
function qualifiedLabels(
  qualifiedConfig: Dict,
  nodeId: string,
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const inbound of (qualifiedConfig["inbounds"] ?? []) as unknown[]) {
    if (isDict(inbound) && typeof inbound["tag"] === "string") {
      const tag = inbound["tag"];
      names[tag] = prettyTag(baseInboundTag(tag, nodeId));
    }
  }
  for (const outbound of (qualifiedConfig["outbounds"] ?? []) as unknown[]) {
    if (isDict(outbound) && typeof outbound["tag"] === "string") {
      const tag = outbound["tag"];
      names[tag] = prettyTag(baseOutboundTag(tag, nodeId));
    }
  }
  return names;
}

/** WHAT: warn for profiles attached to inbounds missing from the config. */
function danglingProfileWarnings(
  authoredConfig: Dict,
  profiles: db.LinkProfileRow[],
): string[] {
  let known: Set<string>;
  try {
    known = new Set(
      inboundSummaries(authoredConfig).map((entry) => entry["tag"] as string),
    );
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    known = new Set();
  }
  const warnings: string[] = [];
  const ordered = [...profiles].sort((left, right) =>
    compareCodePoints(left.id || "", right.id || ""),
  );
  for (const profile of ordered) {
    if (!known.has(profile.inbound_tag)) {
      warnings.push(
        `profile '${profile.id}' references unknown inbound '${profile.inbound_tag}'`,
      );
    }
  }
  return warnings;
}

/**
 * WHAT: return qualified direct and profile links for one node and access
 * row.
 *
 * WHY the qualification order: the link builder reads qualified tags from
 * the config and looks keys up by qualified tag, so config, user, keys, and
 * profiles are all rewritten into the same namespace before any URI is
 * assembled. Warnings from the dangling-profile check are appended after
 * the share-service warnings, matching the Python order.
 */
export async function nodeLinks(
  env: Env,
  node: db.NodeRow,
  accessRow: db.AccessRow,
  status: string,
  profiles: db.LinkProfileRow[],
): Promise<[ShareLink[], string[]]> {
  const shaped = userShape(accessRow.username, status, accessRow);
  const qualifiedConfig = qualifyConfig(node.config_json, node.id) as Dict;
  const qualifiedUser = qualifyUsers([shaped], node.id)[0] as LinkUser;
  const storedKeys = await keyMap(env, node.id);
  const qualifiedKeys = qualifyKeys(storedKeys, node.id) as Record<string, string>;
  const groupedProfiles = qualifyProfiles(profiles, node.id);
  const linkLabels = qualifiedLabels(qualifiedConfig, node.id);
  const [links, warnings] = linksForUser(
    qualifiedUser,
    qualifiedConfig,
    node.address,
    qualifiedKeys,
    groupedProfiles,
    node.label,
    linkLabels,
  );
  warnings.push(
    ...danglingProfileWarnings(node.config_json as Dict, profiles),
  );
  return [links, warnings];
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
 * link generation, so the aggregation never has to re-walk the pairs. The
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
 * WHY the per-node prefix on warnings: a multi-node list stays readable
 * when each entry names its node; the order (skipped, per-node,
 * unaddressable) is part of the tested contract.
 */
async function collectLinks(
  env: Env,
  userStatus: string,
  entries: LinkEntry[],
): Promise<[LinkOut[], string[]]> {
  const links: LinkOut[] = [];
  const warnings: string[] = [];
  for (const [row, node, profiles] of entries) {
    const [generated, nodeWarnings] = await nodeLinks(
      env,
      node,
      row,
      userStatus,
      profiles,
    );
    for (const link of generated) {
      links.push({ ...link, node: node.id });
    }
    warnings.push(...nodeWarnings.map((warning) => `${node.id}: ${warning}`));
  }
  return [links, warnings];
}

/**
 * WHAT: aggregate every link the user is entitled to, across every node.
 *
 * WHY this lives in the service and not the router: the admin links route
 * and the subscription body (M6) are two presentations of one list, and
 * keeping the walk here means they can never disagree. It is read-only —
 * generating links must not write, render, or sync. Status codes are the
 * caller's business: the counts expose the same boundaries the router used
 * to compute inline.
 */
export async function userLinks(
  env: Env,
  username: string,
  status: string,
): Promise<UserLinks> {
  const pairs = await accessPairs(env, username);
  const [skipped, withConfig] = splitConfigPairs(pairs);
  const entries = await addressableEntries(env, withConfig);
  const [links, entryWarnings] = await collectLinks(env, status, entries);
  const warnings = [...skipped, ...entryWarnings, ...unaddressableWarnings(withConfig, entries)];
  return {
    links,
    warnings,
    accessCount: pairs.length,
    withConfigCount: withConfig.length,
    addressableCount: entries.length,
  };
}
