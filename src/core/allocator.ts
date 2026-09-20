/**
 * Allocate VLESS clients and routing rules from user permissions.
 *
 * WHY this exists: turning permissions into `settings.clients` and
 * `routing.rules` is a pure transformation — no I/O, no UUID generation,
 * no config mutation — so it runs identically anywhere and is unit-tested
 * with plain dicts. Callers supply the permissions, the inbound list, the
 * outbound tags, and a pre-generated email→uuid map.
 *
 * WHY the protocol check is the inline literal "vless": the check appears
 * exactly once, so a named constant would add indirection without adding
 * meaning. If Xray ever grows another VLESS-like protocol, this one string
 * is the place to change.
 */

import { pyReprString } from "./python_json";

/** WHAT: the projected permission map the allocator consumes. */
export type UserPermissions = Record<
  string,
  { allowed_inbounds?: string[]; allowed_outbounds?: string[] }
>;

/** WHAT: the inbound fields the allocator reads. */
export type InboundEntry = { tag: string; protocol?: string };

/** WHAT: one generated routing rule (matcher list plus outbound tag). */
export type RoutingRule = { user: string[]; outboundTag: string };

/** WHAT: clients grouped by inbound tag, in generation order. */
export type ClientsByInbound = Record<string, { id: string; email: string }[]>;

/**
 * WHAT: allocate clients per inbound and routing rules per outbound.
 *
 * WHY the loop order is user → outbound → inbound: a missing uuid is a
 * property of the `username@outbound` email, so it is warned once per
 * email and skips every inbound under that exit, exactly like the copied
 * Python core. Warnings are de-duplicated by text.
 */
export function allocate(
  userPermissions: UserPermissions,
  inbounds: InboundEntry[],
  outboundTags: string[],
  uuids: Record<string, string | undefined>,
): [ClientsByInbound, RoutingRule[], string[]] {
  const protocols: Record<string, unknown> = {};
  for (const entry of inbounds) {
    protocols[entry["tag"]] = entry["protocol"];
  }
  const clientsByInbound: ClientsByInbound = {};
  const warnings: string[] = [];
  const seenWarnings = new Set<string>();

  for (const [username, permissions] of Object.entries(userPermissions)) {
    for (const outboundTag of permissions["allowed_outbounds"] ?? []) {
      const email = `${username}@${outboundTag}`;
      const clientId = uuids[email];
      if (!clientId) {
        const message = `missing uuid for ${pyReprString(email)}`;
        if (!seenWarnings.has(message)) {
          seenWarnings.add(message);
          warnings.push(message);
        }
        continue;
      }
      for (const inboundTag of permissions["allowed_inbounds"] ?? []) {
        if (protocols[inboundTag] !== "vless") {
          const message = `skipping non-vless inbound '${inboundTag}'`;
          if (!seenWarnings.has(message)) {
            seenWarnings.add(message);
            warnings.push(message);
          }
          continue;
        }
        (clientsByInbound[inboundTag] ??= []).push({
          id: clientId,
          email,
        });
      }
    }
  }

  const routingRules: RoutingRule[] = outboundTags.map((tag) => ({
    user: [`regexp:.*@${tag}$`],
    outboundTag: tag,
  }));

  return [clientsByInbound, routingRules, warnings];
}
