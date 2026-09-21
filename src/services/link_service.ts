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
import { type LinkUser, linksForUser, type ShareLink } from "./share_service";

/** WHAT: a JSON object carrying authored or qualified config data. */
type Dict = Record<string, unknown>;

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
