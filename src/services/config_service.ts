/**
 * Build the filled runtime Xray config from the user config and users.
 *
 * WHY this exists: turning DB users into `settings.clients` and
 * `routing.rules` is a pure transformation — no bindings, no I/O — so it
 * runs identically anywhere and is unit-tested with plain dicts. The module
 * is the copied single-node render core: qualification happens before it,
 * so nothing here knows about nodes.
 */

import {
  allocate,
  type ClientsByInbound,
  type InboundEntry,
  type RoutingRule,
} from "../core/allocator";

/** WHAT: a JSON object carrying authored or rendered config data. */
type Dict = Record<string, unknown>;

/** WHAT: one projected user in the shape the allocator expects. */
export type User = {
  username: string;
  status: string;
  allowed_inbounds: string[];
  allowed_outbounds: string[];
  uuids: Record<string, string>;
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

/**
 * WHAT: return {username: {allowed_inbounds, allowed_outbounds}} for active users.
 *
 * WHY disabled users are dropped here: a disabled user must disappear from
 * the Xray config on the next sync, so the allocator never sees them.
 */
export function userPermissions(
  users: User[],
): Record<string, { allowed_inbounds: string[]; allowed_outbounds: string[] }> {
  const permissions: Record<
    string,
    { allowed_inbounds: string[]; allowed_outbounds: string[] }
  > = {};
  for (const user of users) {
    if (user["status"] === "active") {
      permissions[user["username"]] = {
        allowed_inbounds: user["allowed_inbounds"],
        allowed_outbounds: user["allowed_outbounds"],
      };
    }
  }
  return permissions;
}

/**
 * WHAT: merge every active user's uuid map into one flat {email: uuid} dict.
 *
 * WHY one flat dict: the allocator is keyed by email
 * (`username@outboundtag`) and knows nothing about users.
 */
export function uuidsMap(users: User[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const user of users) {
    if (user["status"] === "active") {
      Object.assign(merged, user["uuids"]);
    }
  }
  return merged;
}

/** WHAT: the inbound fields the API and allocator expose. */
export type InboundSummary = InboundEntry & {
  network: string;
  security: string;
};

/**
 * WHAT: extract {tag, protocol, network, security} from every inbound.
 *
 * WHY this exists: the allocator only needs tag + protocol; the API
 * endpoint also exposes network and security so the frontend can show
 * richer checkboxes. Extra fields in the dict don't hurt the allocator.
 */
export function inboundSummaries(config: Dict): InboundSummary[] {
  const result: InboundSummary[] = [];
  for (const inbound of config["inbounds"] as Dict[]) {
    const stream = (inbound["streamSettings"] ?? {}) as Dict;
    result.push({
      tag: inbound["tag"] as string,
      protocol: inbound["protocol"] as string,
      network: (stream["network"] ?? "") as string,
      security: (stream["security"] ?? "") as string,
    });
  }
  return result;
}

/**
 * WHAT: return the tag strings of every regular outbound (BLOCK excluded).
 *
 * WHY BLOCK is excluded: it is the default route (guaranteed first by
 * `ensureBlockFirst`), not a real exit node; the allocator must not generate
 * a `regexp:.*@BLOCK$` rule for it.
 */
export function outboundTags(config: Dict): string[] {
  return (config["outbounds"] as Dict[])
    .filter((outbound) => outbound["tag"] !== "BLOCK")
    .map((outbound) => outbound["tag"] as string);
}

/**
 * WHAT: extract {tag, protocol} from every outbound in the config.
 *
 * WHY this exists: the allocator needs just the tag strings, but the API
 * endpoint also exposes the protocol so the frontend can show richer
 * checkboxes.
 */
export function outboundSummaries(
  config: Dict,
): { tag: string; protocol: string }[] {
  return (config["outbounds"] as Dict[]).map((outbound) => ({
    tag: outbound["tag"] as string,
    protocol: outbound["protocol"] as string,
  }));
}

/**
 * WHAT: return the tags of every inbound that has `streamSettings.realitySettings`.
 *
 * WHY presence of realitySettings decides (not `security == "reality"`): a
 * missing or misspelled security value must not silently skip the private
 * key — the panel owns that field whenever the settings block exists.
 * Protocol-agnostic on purpose: REALITY belongs to VLESS in practice, but
 * keying off the settings block keeps this simple and covers any future
 * reality-capable inbound.
 */
export function realityInboundTags(config: Dict): string[] {
  const tags: string[] = [];
  for (const inbound of config["inbounds"] as Dict[]) {
    const stream = (inbound["streamSettings"] ?? {}) as Dict;
    if (isDict(stream["realitySettings"])) {
      tags.push(inbound["tag"] as string);
    }
  }
  return tags;
}

/**
 * WHAT: overwrite `realitySettings.privateKey` of every REALITY inbound;
 * return warnings.
 *
 * WHY a separate pure step instead of part of `buildConfig`: `buildConfig`
 * keeps its original signature (and its tests); the private-key fill is a
 * distinct panel-owned concern that the caller composes in. `runtime` must
 * be the deep copy made by `buildConfig` — mutating the caller's config
 * dict would break the opaque-preservation promise.
 *
 * WHY a missing key only warns: `ensureKeys` guarantees one key per reality
 * inbound, so a gap here is a bug, not an operator error — but keeping the
 * config's own value beats crashing or writing an empty key.
 */
export function applyRealityKeys(
  runtime: Dict,
  keys: Record<string, string>,
): string[] {
  const warnings: string[] = [];
  for (const inbound of runtime["inbounds"] as Dict[]) {
    const stream = (inbound["streamSettings"] ?? {}) as Dict;
    const reality = stream["realitySettings"];
    if (!isDict(reality)) {
      continue;
    }
    const tag = inbound["tag"] as string;
    if (!(tag in keys)) {
      warnings.push(
        `no generated REALITY key for inbound '${tag}';` +
          " keeping the config's own value",
      );
      continue;
    }
    reality["privateKey"] = keys[tag];
  }
  return warnings;
}

/**
 * WHAT: run the allocator; return (clientsByInbound, routingRules, warnings).
 *
 * WHY no catch-all rule is appended: an Xray routing rule needs at least one
 * matcher (user, domain, ip, ...), so a rule carrying only an outboundTag is
 * an error, not a catch-all. Unmatched traffic is already handled by Xray
 * itself, which falls back to the FIRST outbound — the panel guarantees that
 * outbound is BLOCK (see `ensureBlockFirst`).
 */
export function clientsAndRules(
  users: User[],
  config: Dict,
): [ClientsByInbound, RoutingRule[], string[]] {
  return allocate(
    userPermissions(users),
    inboundSummaries(config),
    outboundTags(config),
    uuidsMap(users),
  );
}

/**
 * WHAT: return the outbound list with a blackhole BLOCK guaranteed at index 0.
 *
 * WHY first: when no routing rule matches, Xray uses the FIRST outbound as
 * the default. Placing BLOCK there makes it the catch-all for traffic whose
 * email matched no per-outbound rule — replacing the old matcher-less
 * catch-all rule, which Xray rejects as an error.
 *
 * WHY the existing BLOCK dict is kept verbatim: the operator may have
 * customized it (extra settings, response); only its position changes.
 */
export function ensureBlockFirst(outbounds: Dict[]): Dict[] {
  const block = outbounds.find((outbound) => outbound["tag"] === "BLOCK") ?? {
    tag: "BLOCK",
    protocol: "blackhole",
  };
  const rest = outbounds.filter((outbound) => outbound["tag"] !== "BLOCK");
  return [block, ...rest];
}

/**
 * WHAT: return a deep copy of the config with clients and routing filled in.
 *
 * WHY a deep copy: the caller's config dict must stay untouched — it is
 * re-read from storage on every sync, and mutating it would leak filled
 * state into the opaque parts we promise to preserve.
 *
 * WHY routing is optional: novice operators may omit the routing section
 * entirely; the panel creates it automatically. When the user does supply
 * their own routing.rules, the generated rules are appended after them so
 * user-authored rules stay at the front.
 *
 * WHY BLOCK is forced to the first outbound: an Xray rule needs at least one
 * matcher, so the old matcher-less catch-all rule was an error. Xray's own
 * fallback — "no rule matched → first outbound" — replaces it, and
 * `ensureBlockFirst` guarantees that fallback is BLOCK (injecting a
 * blackhole BLOCK outbound when none exists).
 */
export function buildConfig(config: Dict, users: User[]): [Dict, string[]] {
  const runtime = structuredClone(config);
  runtime["outbounds"] = ensureBlockFirst(
    (runtime["outbounds"] ?? []) as Dict[],
  );
  const [clients, rules, warnings] = clientsAndRules(users, runtime);
  for (const inbound of runtime["inbounds"] as Dict[]) {
    if (inbound["protocol"] !== "vless") {
      continue;
    }
    const settings = inbound["settings"] as Dict;
    settings["clients"] = clients[inbound["tag"] as string] ?? [];
  }
  const routing = (runtime["routing"] ??= {}) as Dict;
  routing["rules"] = ((routing["rules"] ?? []) as unknown[]).concat(rules);
  return [runtime, warnings];
}
