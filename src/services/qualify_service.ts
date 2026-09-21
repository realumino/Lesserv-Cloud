/**
 * Qualify local tags for one node without changing the pure render core.
 *
 * WHY this exists: stored configs, access rows, keys, and profiles use
 * local tags (`reality`, `niigata`) so one authored config can move between
 * nodes. Rendering and share links need node-scoped names
 * (`reality-tokyo01`, `tokyo01-niigata`) so emails, routing rules, and
 * statistics stay globally unambiguous. This module performs only that
 * renaming.
 *
 * WHY separate from `config_service`: the copied render core receives
 * inputs that already look like a single-node panel. Qualification happens
 * before it runs, so `buildConfig` and `applyRealityKeys` never learn about
 * nodes.
 *
 * WHY idempotency is structural: node ids cannot contain hyphens, so an
 * inbound ending in `-{node_id}` and an outbound beginning with
 * `{node_id}-` can only be an already-qualified name. Re-running
 * qualification must leave such names unchanged.
 */

import { compareCodePoints } from "../core/python_json";

/** WHAT: a JSON object being rewritten in place or copied. */
type Dict = Record<string, unknown>;

export const BLOCK_TAG = "BLOCK";

/**
 * WHAT: return true only for a non-empty object (not an array).
 *
 * WHY: config data is arbitrary JSON; every Python `isinstance(x, dict)`
 * check needs a TS counterpart before touching keys.
 */
function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * WHAT: return True when an inbound tag already carries this node's suffix.
 *
 * WHY: idempotency check — node ids cannot contain hyphens, so the suffix
 * is unambiguous.
 */
export function isQualifiedInboundTag(tag: unknown, nodeId: string): boolean {
  return typeof tag === "string" && tag !== "" && tag.endsWith(`-${nodeId}`);
}

/**
 * WHAT: return True when an outbound tag already carries this node's prefix.
 *
 * WHY: idempotency check for the outbound side, mirroring the inbound one.
 */
export function isQualifiedOutboundTag(tag: unknown, nodeId: string): boolean {
  return typeof tag === "string" && tag !== "" && tag.startsWith(`${nodeId}-`);
}

/**
 * WHAT: return one inbound tag with this node's suffix, unless qualified.
 *
 * WHY defensive about non-strings: malformed configs are handled as render
 * warnings elsewhere; the qualifier must preserve and never invent tags.
 */
export function qualifiedInboundTag(tag: unknown, nodeId: string): unknown {
  if (isQualifiedInboundTag(tag, nodeId)) {
    return tag;
  }
  if (typeof tag !== "string" || !tag) {
    return tag;
  }
  return `${tag}-${nodeId}`;
}

/**
 * WHAT: return one outbound tag with this node's prefix, unless qualified.
 *
 * WHY `BLOCK` is exempt: it is the shared default route, not a routable
 * exit. Prefixing it would break the panel-owned fallback and generated
 * rule suppression.
 */
export function qualifiedOutboundTag(tag: unknown, nodeId: string): unknown {
  if (tag === BLOCK_TAG) {
    return tag;
  }
  if (isQualifiedOutboundTag(tag, nodeId)) {
    return tag;
  }
  if (typeof tag !== "string" || !tag) {
    return tag;
  }
  return `${nodeId}-${tag}`;
}

/**
 * WHAT: return the non-empty string tags in one inbound or outbound list.
 *
 * WHY: reference rewriting only touches tags the config actually declares,
 * so the known set is collected before any rewriting starts.
 */
function knownTags(entries: unknown): Set<string> {
  const tags = new Set<string>();
  if (!Array.isArray(entries)) {
    return tags;
  }
  for (const entry of entries) {
    if (isDict(entry)) {
      const tag = entry["tag"];
      if (typeof tag === "string" && tag) {
        tags.add(tag);
      }
    }
  }
  return tags;
}

/**
 * WHAT: qualify tags in place in an already-copied inbound or outbound list.
 *
 * WHY in place: the caller owns the copy (`qualifyConfig` deep-cloned it),
 * so mutation here never reaches stored state.
 */
function qualifyEntries(
  entries: unknown,
  qualifier: (tag: unknown) => unknown,
): void {
  if (!Array.isArray(entries)) {
    return;
  }
  for (const entry of entries) {
    if (isDict(entry)) {
      entry["tag"] = qualifier(entry["tag"]);
    }
  }
}

/**
 * WHAT: split a routing user entry into leading text, tag, and trailing marker.
 *
 * WHY only trailing tags are supported: generated emails have the form
 * `username@tag`, optionally inside `regexp:...` and ending with `$`. A
 * non-terminal tag is not an allocation reference and must stay untouched.
 */
function splitReference(value: string): [string, string, string] | null {
  let text = value;
  let suffix = "";
  if (text.startsWith("regexp:")) {
    text = text.slice("regexp:".length);
  }
  if (text.endsWith("$")) {
    text = text.slice(0, -1);
    suffix = "$";
  }
  const separator = text.lastIndexOf("@");
  if (separator <= 0 || separator === text.length - 1) {
    return null;
  }
  const leading = text.slice(0, separator);
  const tag = text.slice(separator + 1);
  const prefix = value.startsWith("regexp:")
    ? `regexp:${leading}@`
    : `${leading}@`;
  return [prefix, tag, suffix];
}

/**
 * WHAT: rewrite one routing user reference when its trailing tag is known.
 *
 * WHY the known-tags check: a user-authored rule may reference something
 * that is not an allocation email; only references to real outbound tags
 * are rewritten.
 */
function rewriteKnownReference(
  value: unknown,
  known: Set<string>,
  nodeId: string,
): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const parts = splitReference(value);
  if (parts === null) {
    return value;
  }
  const [prefix, tag, suffix] = parts;
  if (!known.has(tag)) {
    return value;
  }
  return `${prefix}${qualifiedOutboundTag(tag, nodeId)}${suffix}`;
}

/**
 * WHAT: rewrite references in a string or list while preserving its shape.
 *
 * WHY shape preservation: routing rules accept a string or a list of
 * strings, and qualification must not turn one into the other.
 */
function rewriteReferenceList(
  values: unknown,
  known: Set<string>,
  nodeId: string,
): unknown {
  if (typeof values === "string") {
    return rewriteKnownReference(values, known, nodeId);
  }
  if (Array.isArray(values)) {
    return values.map((value) => rewriteKnownReference(value, known, nodeId));
  }
  return values;
}

/**
 * WHAT: qualify an inbound or outbound reference only when the tag is known.
 *
 * WHY: unknown references are operator-authored and must be preserved
 * verbatim, exactly like the Python qualifier.
 */
function qualifyTaggedReference(
  value: unknown,
  known: Set<string>,
  qualifier: (tag: unknown) => unknown,
): unknown {
  if (typeof value === "string" && known.has(value)) {
    return qualifier(value);
  }
  return value;
}

/**
 * WHAT: qualify tag references in a string or list while preserving shape.
 *
 * WHY: `inboundTag` may be a single string or a list; both forms exist in
 * real Xray configs.
 */
function qualifyReferenceList(
  values: unknown,
  known: Set<string>,
  qualifier: (tag: unknown) => unknown,
): unknown {
  if (typeof values === "string") {
    return qualifyTaggedReference(values, known, qualifier);
  }
  if (Array.isArray(values)) {
    return values.map((value) => qualifyTaggedReference(value, known, qualifier));
  }
  return values;
}

/**
 * WHAT: rewrite tag references in one already-copied routing rule in place.
 *
 * WHY each key is checked separately: `outboundTag` is a plain tag,
 * `inboundTag` is a tag reference, and `user` carries email-shaped
 * references — each needs a different rewrite.
 */
function qualifyRoutingRule(
  rule: unknown,
  inboundTags: Set<string>,
  outboundTags: Set<string>,
  nodeId: string,
): void {
  if (!isDict(rule)) {
    return;
  }
  if ("outboundTag" in rule) {
    rule["outboundTag"] = qualifyTaggedReference(
      rule["outboundTag"],
      outboundTags,
      (tag) => qualifiedOutboundTag(tag, nodeId),
    );
  }
  if ("inboundTag" in rule) {
    rule["inboundTag"] = qualifyReferenceList(
      rule["inboundTag"],
      inboundTags,
      (tag) => qualifiedInboundTag(tag, nodeId),
    );
  }
  if ("user" in rule) {
    rule["user"] = rewriteReferenceList(rule["user"], outboundTags, nodeId);
  }
}

/**
 * WHAT: rewrite tag references in an already-copied routing section in place.
 *
 * WHY optional: novice operators may omit routing entirely; the render core
 * creates it later.
 */
function qualifyRouting(
  config: Dict,
  inboundTags: Set<string>,
  outboundTags: Set<string>,
  nodeId: string,
): void {
  const routing = config["routing"];
  if (!isDict(routing)) {
    return;
  }
  const rules = routing["rules"];
  if (!Array.isArray(rules)) {
    return;
  }
  for (const rule of rules) {
    qualifyRoutingRule(rule, inboundTags, outboundTags, nodeId);
  }
}

/**
 * WHAT: return a qualified copy of one authored config.
 *
 * WHY a copy: the stored config must remain identity-free. The caller may
 * reuse the same authored object for another node, so mutation would leak
 * one node's identity into another render.
 */
export function qualifyConfig(config: unknown, nodeId: string): unknown {
  const qualified = structuredClone(config);
  if (!isDict(qualified)) {
    return qualified;
  }
  const inboundTags = knownTags(qualified["inbounds"]);
  const outboundTags = knownTags(qualified["outbounds"]);
  qualifyEntries(qualified["inbounds"], (tag) =>
    qualifiedInboundTag(tag, nodeId),
  );
  qualifyEntries(qualified["outbounds"], (tag) =>
    qualifiedOutboundTag(tag, nodeId),
  );
  qualifyRouting(qualified, inboundTags, outboundTags, nodeId);
  return qualified;
}

/**
 * WHAT: qualify the strings in a list while leaving other values unchanged.
 *
 * WHY no known-tags check: an access list is already scoped to this node's
 * authored tags, so every string entry is a local tag by construction.
 */
function qualifyStringList(
  values: unknown,
  qualifier: (tag: unknown) => unknown,
): unknown {
  if (!Array.isArray(values)) {
    return values;
  }
  return values.map((value) => qualifier(value));
}

/**
 * WHAT: qualify the outbound part of a `username@tag` uuid-map key.
 *
 * WHY the first-@ split: usernames cannot contain `@`, so the first `@`
 * separates username from tag, exactly like Python's `partition`.
 */
function qualifyEmailKey(email: unknown, nodeId: string): unknown {
  if (typeof email !== "string") {
    return email;
  }
  const separator = email.indexOf("@");
  if (separator <= 0 || separator === email.length - 1) {
    return email;
  }
  const username = email.slice(0, separator);
  const tag = email.slice(separator + 1);
  return `${username}@${qualifiedOutboundTag(tag, nodeId)}`;
}

/**
 * WHAT: return one projected user with node-qualified lists and uuid keys.
 *
 * WHY a shallow copy: the projection is rebuilt per render, but the caller
 * may still hold the original; copying keeps this function free of side
 * effects.
 */
function qualifyUser(user: Dict, nodeId: string): Dict {
  const qualified: Dict = { ...user };
  qualified["allowed_inbounds"] = qualifyStringList(
    user["allowed_inbounds"],
    (tag) => qualifiedInboundTag(tag, nodeId),
  );
  qualified["allowed_outbounds"] = qualifyStringList(
    user["allowed_outbounds"],
    (tag) => qualifiedOutboundTag(tag, nodeId),
  );
  const uuids = user["uuids"];
  if (isDict(uuids)) {
    const mapped: Dict = {};
    for (const [email, value] of Object.entries(uuids)) {
      mapped[qualifyEmailKey(email, nodeId) as string] = value;
    }
    qualified["uuids"] = mapped;
  }
  return qualified;
}

/**
 * WHAT: return projected users with node-qualified access and uuid keys.
 *
 * WHY the stored rows are not enough: the render projection builds uuid
 * keys as `username@local-tag`; the allocator then needs those same keys
 * with qualified tags. This is the only function that touches those keys.
 */
export function qualifyUsers(
  users: unknown[] | null | undefined,
  nodeId: string,
): unknown[] {
  return (users ?? []).map((user) =>
    isDict(user) ? qualifyUser(user, nodeId) : user,
  );
}

/**
 * WHAT: return stored REALITY keys indexed by qualified inbound tag.
 *
 * WHY reindex here: storage follows local inbound tags, while the runtime
 * produced from a qualified config looks keys up by qualified tag. The
 * stored map itself is never changed.
 */
export function qualifyKeys(
  keys: Record<string, unknown> | null | undefined,
  nodeId: string,
): Record<string, unknown> {
  const qualified: Record<string, unknown> = {};
  for (const [tag, value] of Object.entries(keys ?? {})) {
    qualified[qualifiedInboundTag(tag, nodeId) as string] = value;
  }
  return qualified;
}

/**
 * WHAT: sort one profile id the way Python's `entry.get("id") or ""` does.
 *
 * WHY: missing and falsy ids sort as the empty string; the ids are stored
 * UUID strings in practice.
 */
function profileSortKey(value: unknown): string | number {
  return (value as string | number) || "";
}

/**
 * WHAT: compare two profile entries by their sort keys.
 *
 * WHY: profile order inside one inbound must be stable for deterministic
 * link output; JS sort is stable, so only the key matters.
 */
function compareProfiles(left: Dict, right: Dict): number {
  const a = profileSortKey(left["id"]);
  const b = profileSortKey(right["id"]);
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * WHAT: group link profiles by qualified inbound tag for link generation.
 *
 * WHY the grouping shape: links are generated from the qualified config,
 * while profiles are stored against local inbound tags. Grouping once lets
 * the link loop find every variant for the current inbound directly, and
 * sorting keys keeps output deterministic across engines.
 */
export function qualifyProfiles(
  profiles: unknown[] | null | undefined,
  nodeId: string,
): Record<string, Dict[]> {
  const grouped: Record<string, Dict[]> = {};
  for (const profile of profiles ?? []) {
    if (!isDict(profile)) {
      continue;
    }
    const inbound = profile["inbound_tag"];
    if (typeof inbound !== "string" || !inbound) {
      continue;
    }
    const entry: Dict = {
      id: profile["id"],
      label: profile["label"],
      overrides: isDict(profile["overrides"])
        ? { ...profile["overrides"] }
        : {},
    };
    const key = qualifiedInboundTag(inbound, nodeId) as string;
    (grouped[key] ??= []).push(entry);
  }
  for (const entries of Object.values(grouped)) {
    entries.sort(compareProfiles);
  }
  const sorted: Record<string, Dict[]> = {};
  for (const key of Object.keys(grouped).sort(compareCodePoints)) {
    sorted[key] = grouped[key];
  }
  return sorted;
}

/**
 * WHAT: report blank or already-qualified tags in one config section.
 *
 * WHY only this validation: the config remains otherwise opaque. This check
 * prevents an already-qualified tag from being qualified again at render
 * time, which would otherwise produce names such as
 * `reality-tokyo01-tokyo01`.
 */
function tagErrors(
  entries: unknown,
  kind: string,
  nodeId: string,
  isQualified: (tag: unknown, nodeId: string) => boolean,
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(entries)) {
    return errors;
  }
  for (const [position, entry] of entries.entries()) {
    if (!isDict(entry)) {
      continue;
    }
    const tag = entry["tag"];
    if (typeof tag !== "string" || !tag) {
      errors.push(`${kind} ${position} has no tag`);
    } else if (isQualified(tag, nodeId)) {
      errors.push(
        `${kind} tag '${tag}' is already qualified for node '${nodeId}'`,
      );
    }
  }
  return errors;
}

/**
 * WHAT: return paste-time errors for local inbound and outbound tags.
 *
 * WHY at paste time: catching a pre-qualified tag when the config is
 * submitted gives the operator a precise message, instead of a mysterious
 * double-qualified tag inside a rendered config.
 */
export function localTagErrors(config: unknown, nodeId: string): string[] {
  if (!isDict(config)) {
    return [];
  }
  const errors = tagErrors(
    config["inbounds"],
    "inbound",
    nodeId,
    isQualifiedInboundTag,
  );
  errors.push(
    ...tagErrors(config["outbounds"], "outbound", nodeId, isQualifiedOutboundTag),
  );
  return errors;
}
