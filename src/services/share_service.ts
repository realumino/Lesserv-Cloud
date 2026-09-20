/**
 * Build VLESS share links from a user and the Xray config.
 *
 * WHY this is a separate service: turning users + inbounds into `vless://`
 * URIs is a pure transformation. It never touches storage or subprocess, so
 * it can be unit-tested with plain dicts. Optional profiles add extra
 * client-side variants without changing the direct URI behavior.
 *
 * WHY Python's `urllib.parse` semantics are reproduced by hand: these bytes
 * are copied by users and pinned by tests, and `encodeURIComponent` differs
 * from `urllib.parse.quote` on `!'()*`. All URI assembly goes through
 * `python_uri.ts`.
 */

import { compareCodePoints, pyStr } from "../core/python_json";
import { pyQuote, pyUrlEncode } from "../core/python_uri";
import { derivePublicKey } from "../core/x25519";
import { linkLabel } from "./labels";

/** WHAT: a JSON object carrying config or profile data. */
type Dict = Record<string, unknown>;

/** WHAT: one projected user in the shape links are generated from. */
export type LinkUser = {
  username: string;
  status?: string;
  allowed_inbounds?: string[];
  allowed_outbounds?: string[];
  uuids: Record<string, string>;
};

/** WHAT: one generated share link. */
export type ShareLink = {
  inbound: string;
  outbound: string;
  email: string;
  profile: string | null;
  label: string | null;
  uri: string;
};

/** WHAT: one exit link request (email + uuid) before inbounds are applied. */
type ExitRequest = { outbound_tag: string; email: string; uuid: string };

/** WHAT: one inbound variant: the direct view or one attached profile. */
type Variant = {
  profile_id: string | null;
  label: string | null;
  overrides: Dict;
};

/** WHAT: the resolved inputs every link-building step shares. */
type LinkInput = {
  configured_address: string;
  reality_keys: Record<string, string> | null;
  profiles: Record<string, Dict[]>;
  node_label: string | null;
  labels: Record<string, string>;
};

const WILDCARD_LISTENS = new Set(["", "0.0.0.0", "::"]);

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
 * WHAT: return the server address for an inbound.
 *
 * WHY the configured address wins: the operator's public domain/IP is not
 * necessarily the same address Xray binds to (often `0.0.0.0`).
 */
export function resolveAddress(
  configured: string | null | undefined,
  inbound: Dict,
): string | null {
  if (configured) {
    return configured;
  }
  const listen = inbound["listen"] ?? "";
  if (WILDCARD_LISTENS.has(listen as string)) {
    return null;
  }
  return listen as string;
}

/**
 * WHAT: return True when at least one inbound has a resolvable address.
 *
 * WHY this exists: the router needs to distinguish "no address" (409) from
 * "links could be built for some inbounds". A profile may supply the
 * client-facing address even when the direct view cannot resolve one.
 */
export function hasUsableAddress(
  config: Dict,
  configured: string,
  profileAddresses: unknown[] = [],
): boolean {
  if (configured) {
    return true;
  }
  for (const inbound of (config["inbounds"] ?? []) as Dict[]) {
    if (resolveAddress(null, inbound) !== null) {
      return true;
    }
  }
  return profileAddresses.some((address) => Boolean(address));
}

/**
 * WHAT: bracket IPv6 addresses; leave IPv4/domain as-is.
 *
 * WHY: a raw IPv6 literal in a URI authority must be bracketed, or the
 * colons read as a port separator.
 */
function hostInUri(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/**
 * WHAT: return the first non-empty item of a list, or null.
 *
 * WHY Python truthiness: `_first([""])` is None, which is what the callers
 * rely on to decide whether to emit a query parameter.
 */
function first(values: unknown): unknown {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  return values[0] ? values[0] : null;
}

/**
 * WHAT: build transport query params and any warnings for an inbound.
 *
 * WHY the network names are mapped: the share-link standard uses `type=tcp`
 * for the RAW transport, even though Xray 25+ calls it `raw` in the config.
 */
function transportParams(inbound: Dict): [Dict, string[]] {
  const stream = (inbound["streamSettings"] ?? {}) as Dict;
  const network = (stream["network"] ?? "tcp") as string;
  const params: Dict = {};
  const warnings: string[] = [];

  params["type"] = network === "raw" ? "tcp" : network;

  if (network === "tcp" || network === "raw") {
    return [params, warnings];
  }

  if (network === "ws") {
    const ws = (stream["wsSettings"] ?? {}) as Dict;
    if (ws["path"]) {
      params["path"] = ws["path"];
    }
    if (ws["host"]) {
      params["host"] = ws["host"];
    }
  } else if (network === "xhttp") {
    const xhttp = (stream["xhttpSettings"] ?? {}) as Dict;
    if (xhttp["path"]) {
      params["path"] = xhttp["path"];
    }
    if (xhttp["host"]) {
      params["host"] = xhttp["host"];
    }
    if (xhttp["mode"]) {
      params["mode"] = xhttp["mode"];
    }
  } else if (network === "grpc") {
    const grpc = (stream["grpcSettings"] ?? {}) as Dict;
    if (grpc["serviceName"]) {
      params["serviceName"] = grpc["serviceName"];
    }
    if (grpc["multiMode"]) {
      params["mode"] = "multi";
    }
  } else if (network === "httpupgrade") {
    const httpupgrade = (stream["httpupgradeSettings"] ?? {}) as Dict;
    if (httpupgrade["path"]) {
      params["path"] = httpupgrade["path"];
    }
    if (httpupgrade["host"]) {
      params["host"] = httpupgrade["host"];
    }
  } else {
    warnings.push(
      `unsupported network '${network}' for inbound '${pyStr(inbound["tag"])}'`,
    );
  }

  return [params, warnings];
}

/**
 * WHAT: build security query params and any warnings for an inbound.
 *
 * WHY the private key comes from `realityKeys` when available: the panel
 * owns `realitySettings.privateKey` (stored sealed, injected at render), so
 * the config's copy may be stale or a placeholder. Deriving `pbk` from the
 * panel's key is what makes links match what Xray actually serves. The
 * config value remains the fallback so pure callers without a database
 * still work.
 */
function securityParams(
  inbound: Dict,
  realityKeys: Record<string, string> | null,
): [Dict, string[]] {
  const stream = (inbound["streamSettings"] ?? {}) as Dict;
  const security = (stream["security"] ?? "none") as string;
  const params: Dict = {};
  const warnings: string[] = [];

  if (security === "none") {
    return [params, warnings];
  }

  params["security"] = security;

  if (security === "reality") {
    const reality = (stream["realitySettings"] ?? {}) as Dict;
    const sni = first(reality["serverNames"] ?? []);
    if (sni) {
      params["sni"] = sni;
    }

    const settings = (reality["settings"] ?? {}) as Dict;
    const fingerprint = settings["fingerprint"] || reality["fingerprint"];
    params["fp"] = fingerprint || "chrome";

    const privateKey =
      (realityKeys ?? {})[inbound["tag"] as string] || reality["privateKey"];
    if (privateKey) {
      const publicKey = derivePublicKey(privateKey as string);
      if (publicKey) {
        params["pbk"] = publicKey;
      } else {
        warnings.push(
          `invalid privateKey for inbound '${pyStr(inbound["tag"])}'`,
        );
      }
    } else {
      warnings.push(`missing privateKey for inbound '${pyStr(inbound["tag"])}'`);
    }

    const shortId = first(reality["shortIds"] ?? []);
    if (shortId) {
      params["sid"] = shortId;
    }

    if (reality["spiderX"]) {
      params["spx"] = reality["spiderX"];
    }
  } else if (security === "tls") {
    const tls = (stream["tlsSettings"] ?? {}) as Dict;
    const sni = tls["serverName"] || first(tls["serverNames"] ?? []);
    if (sni) {
      params["sni"] = sni;
    }
    if (tls["alpn"]) {
      params["alpn"] = (tls["alpn"] as string[]).join(",");
    }
    const settings = (tls["settings"] ?? {}) as Dict;
    const fingerprint = tls["fingerprint"] || settings["fingerprint"];
    if (fingerprint) {
      params["fp"] = fingerprint;
    }
  }

  return [params, warnings];
}

/**
 * WHAT: return the VLESS `flow` query param when the inbound sets one.
 *
 * WHY flow comes from the inbound: Xray lets the operator declare flow once
 * per inbound (`settings.flow`) instead of per client, so there is nothing
 * user-specific to store. The panel echoes whatever the operator wrote
 * without judging whether it fits the transport.
 */
function flowParams(inbound: Dict): Dict {
  const flow = ((inbound["settings"] ?? {}) as Dict)["flow"];
  return flow ? { flow } : {};
}

/**
 * WHAT: assemble a `vless://` URI from its parts.
 *
 * WHY params are ordered explicitly: deterministic URIs are easier to test
 * and compare. `pyQuote` is used instead of `encodeURIComponent` so spaces
 * become %20, not `+`, and `!'()*` are escaped like Python does. A supplied
 * readable remark replaces the archived technical remark; otherwise
 * behavior is unchanged.
 */
function buildUri(
  email: string,
  uuid: string,
  address: string,
  port: unknown,
  params: Dict,
  inboundTag: string,
  remark: string | null = null,
): string {
  const host = hostInUri(address);
  const query = pyUrlEncode(params);
  const finalRemark = remark ?? `${email} (${inboundTag})`;
  return `vless://${uuid}@${host}:${port}?${query}#${pyQuote(finalRemark)}`;
}

/**
 * WHAT: index a config's outbound set and inbound map for link generation.
 *
 * WHY sets and maps: outbound membership is tested often, and inbound
 * lookup is by tag; both are built once per user instead of per inbound.
 */
function indexConfig(config: Dict): [Set<string>, Map<string, Dict>] {
  const outboundTags = new Set<string>();
  for (const outbound of (config["outbounds"] ?? []) as Dict[]) {
    outboundTags.add(outbound["tag"] as string);
  }
  const inbounds = new Map<string, Dict>();
  for (const inbound of (config["inbounds"] ?? []) as Dict[]) {
    inbounds.set(inbound["tag"] as string, inbound);
  }
  return [outboundTags, inbounds];
}

/**
 * WHAT: return per-exit link requests and warnings for unusable exits.
 *
 * WHY sorted: deterministic link order is part of the tested contract, and
 * exits are the outermost loop.
 */
function exitRequests(
  user: LinkUser,
  outboundTags: Set<string>,
): [ExitRequest[], string[]] {
  const requests: ExitRequest[] = [];
  const warnings: string[] = [];
  const allowed = [...(user["allowed_outbounds"] ?? [])].sort(compareCodePoints);
  for (const outboundTag of allowed) {
    if (!outboundTags.has(outboundTag)) {
      warnings.push(`unknown outbound '${outboundTag}'`);
      continue;
    }
    const email = `${user["username"]}@${outboundTag}`;
    const uuid = user["uuids"][email];
    if (!uuid) {
      warnings.push(`missing uuid for ${email}`);
      continue;
    }
    requests.push({ outbound_tag: outboundTag, email, uuid });
  }
  return [requests, warnings];
}

/**
 * WHAT: return the direct variant followed by attached profile variants.
 *
 * WHY direct first: the direct URI is the canonical one; profiles are
 * optional client-side replacements that follow it.
 */
function profileVariants(
  inboundTag: string,
  profiles: Record<string, Dict[]>,
): Variant[] {
  const variants: Variant[] = [
    { profile_id: null, label: null, overrides: {} },
  ];
  for (const profile of profiles[inboundTag] ?? []) {
    variants.push({
      profile_id: (profile["id"] as string) ?? null,
      label: (profile["label"] as string) ?? null,
      overrides: isDict(profile["overrides"]) ? { ...profile["overrides"] } : {},
    });
  }
  return variants;
}

/**
 * WHAT: return one variant's URI address and port, with overrides applied.
 *
 * WHY dedicated handling: address and port are URI components rather than
 * query parameters, so they are replaced instead of merged.
 */
function variantAddressPort(
  variant: Variant,
  address: string | null,
  port: unknown,
): [unknown, unknown] {
  const overrides = variant["overrides"] ?? {};
  const variantAddress = overrides["address"] || address;
  let variantPort = overrides["port"];
  if (variantPort === null || variantPort === undefined) {
    variantPort = port;
  }
  return [variantAddress, variantPort];
}

/**
 * WHAT: return one variant's readable label, or null for pure callers.
 *
 * WHY null when no node label: a pure caller has no fleet context to name,
 * so no remark is invented.
 */
function variantLabel(
  variant: Variant,
  inboundTag: string,
  outboundTag: string,
  nodeLabel: string | null,
  labels: Record<string, string>,
): string | null {
  if (nodeLabel === null || nodeLabel === undefined) {
    return null;
  }
  const subject = variant["label"] || labels[inboundTag] || inboundTag;
  return linkLabel(nodeLabel, subject, labels[outboundTag] ?? outboundTag);
}

/**
 * WHAT: build one link variant or report its missing address.
 *
 * WHY profile overrides win: a profile is an intentional client-side
 * replacement for connection details.
 */
function variantLink(
  email: string,
  uuid: string,
  inboundTag: string,
  outboundTag: string,
  variant: Variant,
  address: string | null,
  port: unknown,
  params: Dict,
  nodeLabel: string | null,
  labels: Record<string, string>,
): [ShareLink | null, string[]] {
  const overrides = variant["overrides"] ?? {};
  const [variantAddress, variantPort] = variantAddressPort(variant, address, port);
  if (!variantAddress) {
    return [null, [`no address for inbound '${inboundTag}'`]];
  }
  const variantParams = { ...params };
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== "address" && key !== "port") {
      variantParams[key] = value;
    }
  }
  const label = variantLabel(variant, inboundTag, outboundTag, nodeLabel, labels);
  const uri = buildUri(
    email,
    uuid,
    variantAddress as string,
    variantPort,
    variantParams,
    inboundTag,
    label,
  );
  const link: ShareLink = {
    inbound: inboundTag,
    outbound: outboundTag,
    email,
    profile: variant["profile_id"],
    label,
    uri,
  };
  return [link, []];
}

/**
 * WHAT: build direct and profile links for one allowed inbound.
 *
 * WHY port is required: a URI without a port cannot connect, so a missing
 * port is a warning, not a link with a broken authority.
 */
function linksForInbound(
  email: string,
  uuid: string,
  inboundTag: string,
  inbound: Dict,
  outboundTag: string,
  linkInput: LinkInput,
): [ShareLink[], string[]] {
  const links: ShareLink[] = [];
  const warnings: string[] = [];
  const port = inbound["port"];
  if (!port) {
    return [links, [`inbound '${inboundTag}' missing port`]];
  }
  const address = resolveAddress(linkInput["configured_address"], inbound);
  const [transport, transportWarnings] = transportParams(inbound);
  const [security, securityWarnings] = securityParams(
    inbound,
    linkInput["reality_keys"],
  );
  warnings.push(...transportWarnings, ...securityWarnings);
  const params: Dict = { encryption: "none" };
  Object.assign(params, transport, security, flowParams(inbound));
  for (const variant of profileVariants(inboundTag, linkInput["profiles"])) {
    const [link, variantWarnings] = variantLink(
      email,
      uuid,
      inboundTag,
      outboundTag,
      variant,
      address,
      port,
      params,
      linkInput["node_label"],
      linkInput["labels"],
    );
    warnings.push(...variantWarnings);
    if (link !== null) {
      links.push(link);
    }
  }
  return [links, warnings];
}

/**
 * WHAT: build every link for one exit across the user's allowed inbounds.
 *
 * WHY sorted inbounds: the link order inside one exit is part of the tested
 * contract.
 */
function linksForExit(
  request: ExitRequest,
  allowedInbounds: string[],
  configInbounds: Map<string, Dict>,
  linkInput: LinkInput,
): [ShareLink[], string[]] {
  const links: ShareLink[] = [];
  const warnings: string[] = [];
  for (const inboundTag of [...allowedInbounds].sort(compareCodePoints)) {
    const inbound = configInbounds.get(inboundTag);
    if (!inbound) {
      warnings.push(`unknown inbound '${inboundTag}'`);
      continue;
    }
    if (inbound["protocol"] !== "vless") {
      warnings.push(`skipping non-vless inbound '${inboundTag}'`);
      continue;
    }
    const [inboundLinks, inboundWarnings] = linksForInbound(
      request["email"],
      request["uuid"],
      inboundTag,
      inbound,
      request["outbound_tag"],
      linkInput,
    );
    links.push(...inboundLinks);
    warnings.push(...inboundWarnings);
  }
  return [links, warnings];
}

/**
 * WHAT: build links and warnings for every usable exit request.
 *
 * WHY a separate fold: exits are independent; one unusable exit must not
 * stop links for the others.
 */
function linksForRequests(
  requests: ExitRequest[],
  allowedInbounds: string[],
  configInbounds: Map<string, Dict>,
  linkInput: LinkInput,
): [ShareLink[], string[]] {
  const links: ShareLink[] = [];
  const warnings: string[] = [];
  for (const request of requests) {
    const [exitLinks, exitWarnings] = linksForExit(
      request,
      allowedInbounds,
      configInbounds,
      linkInput,
    );
    links.push(...exitLinks);
    warnings.push(...exitWarnings);
  }
  return [links, warnings];
}

/**
 * WHAT: add status warnings and return links in deterministic order.
 *
 * WHY sort by (inbound, outbound, profile): the frontend renders the list
 * as-is, and stable order makes the API response diffable across syncs.
 */
function finalizeLinks(
  username: string,
  status: string | undefined,
  links: ShareLink[],
  warnings: string[],
): [ShareLink[], string[]] {
  if (status !== "active") {
    warnings.push(`user ${username} is disabled`);
  }
  links.sort((left, right) => {
    const byInbound = compareCodePoints(left["inbound"], right["inbound"]);
    if (byInbound !== 0) {
      return byInbound;
    }
    const byOutbound = compareCodePoints(left["outbound"], right["outbound"]);
    if (byOutbound !== 0) {
      return byOutbound;
    }
    return compareCodePoints(left["profile"] ?? "", right["profile"] ?? "");
  });
  return [links, warnings];
}

/**
 * WHAT: return all share links for a user plus warnings.
 *
 * WHY one link per (inbound, outbound) pair: the UUID differs per outbound
 * email, so a single user has a distinct URI for each exit node they are
 * allowed to use. Each profile attached to an inbound adds one more URI per
 * exit, using the same UUID but its own client-facing connection details.
 *
 * WHY realityKeys is optional: the router always passes the DB map; the
 * default keeps this function usable without a database (tests, ad-hoc
 * scripts) with links derived from the config's own keys.
 */
export function linksForUser(
  user: LinkUser,
  config: Dict,
  configuredAddress: string,
  realityKeys: Record<string, string> | null = null,
  profiles: Record<string, Dict[]> | null = null,
  nodeLabel: string | null = null,
  labels: Record<string, string> | null = null,
): [ShareLink[], string[]] {
  const [outboundTags, configInbounds] = indexConfig(config);
  const [requests, warnings] = exitRequests(user, outboundTags);
  const linkInput: LinkInput = {
    configured_address: configuredAddress,
    reality_keys: realityKeys,
    profiles: profiles ?? {},
    node_label: nodeLabel,
    labels: labels ?? {},
  };
  const [links, requestWarnings] = linksForRequests(
    requests,
    user["allowed_inbounds"] ?? [],
    configInbounds,
    linkInput,
  );
  warnings.push(...requestWarnings);
  return finalizeLinks(user["username"], user["status"], links, warnings);
}
