/**
 * Business rules for per-inbound link profiles.
 *
 * WHY this layer exists: profiles are stored link variants, not config.
 * Their rules — attachment to a real authored inbound and a node-scoped
 * identity — belong here. Profile writes never sync nodes because profiles
 * never enter the rendered runtime config.
 */

import * as db from "../db";
import type {
  LinkProfileIn,
  LinkProfileOut,
  LinkProfileUpdate,
} from "../models";
import { inboundSummaries } from "./config_service";

/** WHAT: Unix seconds from the plane's clock (the time authority). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** WHAT: project a database profile to the LinkProfileOut shape. */
function toOut(profile: db.LinkProfileRow): LinkProfileOut {
  return {
    id: profile.id,
    inbound_tag: profile.inbound_tag,
    label: profile.label,
    overrides: profile.overrides,
    created_at: profile.created_at,
  };
}

/**
 * WHAT: return inbound tags from an authored config, tolerating bad shapes.
 *
 * WHY the catch: this runs on stored data that predates the current
 * validation, and a profile check must not crash on a malformed config —
 * it simply finds no attachable inbound. Only the shape errors Python
 * caught (TypeError here) are swallowed; real bugs still throw.
 */
function authoredInboundTags(config: Record<string, unknown>): Set<string> {
  try {
    return new Set(
      inboundSummaries(config).map((entry) => entry["tag"] as string),
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return new Set();
    }
    throw error;
  }
}

/** WHAT: return semantic errors for a new profile, without touching storage. */
export function validateCreate(
  node: db.NodeRow,
  data: LinkProfileIn,
): string[] {
  if (node.config_json === null) {
    return ["node has no config to attach a profile to"];
  }
  if (!authoredInboundTags(node.config_json).has(data.inbound_tag)) {
    return [`unknown inbound '${data.inbound_tag}'`];
  }
  return [];
}

/** WHAT: return semantic errors for a profile update, without storage. */
export function validateUpdate(
  node: db.NodeRow,
  data: LinkProfileUpdate,
): string[] {
  if (data.inbound_tag === null) {
    return [];
  }
  if (node.config_json === null) {
    return ["node has no config to attach a profile to"];
  }
  if (!authoredInboundTags(node.config_json).has(data.inbound_tag)) {
    return [`unknown inbound '${data.inbound_tag}'`];
  }
  return [];
}

/** WHAT: return one node's profiles in deterministic display order. */
export async function listProfiles(
  conn: D1Database,
  nodeId: string,
): Promise<LinkProfileOut[]> {
  return (await db.listLinkProfiles(conn, nodeId)).map(toOut);
}

/** WHAT: return one profile in API shape, or null when missing. */
export async function getProfile(
  conn: D1Database,
  nodeId: string,
  profileId: string,
): Promise<LinkProfileOut | null> {
  const profile = await db.getLinkProfile(conn, nodeId, profileId);
  return profile !== null ? toOut(profile) : null;
}

/** WHAT: store one validated profile and stamp its creation time. */
export async function createProfile(
  conn: D1Database,
  nodeId: string,
  data: LinkProfileIn,
): Promise<LinkProfileOut> {
  const profile: db.LinkProfileRow = {
    node_id: nodeId,
    id: data.id,
    inbound_tag: data.inbound_tag,
    label: data.label,
    overrides: { ...data.overrides },
    created_at: nowSeconds(),
  };
  await db.createLinkProfile(conn, profile);
  return toOut(profile);
}

/** WHAT: merge a partial profile update; null when the profile is missing. */
export async function updateProfile(
  conn: D1Database,
  nodeId: string,
  profileId: string,
  data: LinkProfileUpdate,
): Promise<LinkProfileOut | null> {
  const stored = await db.getLinkProfile(conn, nodeId, profileId);
  if (stored === null) {
    return null;
  }
  if (data.inbound_tag !== null) {
    stored.inbound_tag = data.inbound_tag;
  }
  if (data.label !== null) {
    stored.label = data.label;
  }
  if (data.overrides !== null) {
    stored.overrides = { ...data.overrides };
  }
  await db.updateLinkProfile(conn, stored);
  return toOut(
    (await db.getLinkProfile(conn, nodeId, profileId)) as db.LinkProfileRow,
  );
}

/** WHAT: remove one profile; false when it did not exist. */
export async function deleteProfile(
  conn: D1Database,
  nodeId: string,
  profileId: string,
): Promise<boolean> {
  if ((await db.getLinkProfile(conn, nodeId, profileId)) === null) {
    return false;
  }
  await db.deleteLinkProfile(conn, nodeId, profileId);
  return true;
}
