/**
 * The subscription body: one user's links, base64-encoded for clients.
 *
 * WHY this is a service and not router logic: the aggregation it reads
 * (`link_service.userLinks`) is shared with the admin links route, so the
 * two presentations can never disagree. This module adds the subscription
 * contract on top: token lookup, entitlement, encoding, and the rule that
 * anything not entitled is an empty body — never an error.
 */

import * as db from "../db";
import { bytesToBase64 } from "../crypto";
import { userLinks } from "./link_service";
import { isEntitled, nowSeconds } from "./user_service";

/**
 * WHAT: encode URIs as base64 of their newline-joined list.
 *
 * WHY UTF-8 bytes and not `btoa` directly: `btoa` is Latin-1 only, and a
 * node address (part of every URI) may contain non-ASCII; encoding the
 * bytes first means one odd address can never throw and break a whole
 * subscription. Standard alphabet with padding, `uri1\nuri2` with no
 * trailing newline; an empty list encodes to the empty string, which is
 * exactly the "nothing entitled" body.
 */
export function encodeSubscription(uris: string[]): string {
  return bytesToBase64(new TextEncoder().encode(uris.join("\n")));
}

/**
 * WHAT: return the full subscription body for one token, or "" when the
 * token does not resolve to an entitled user.
 *
 * WHY every failure is "" and never an error: a capability URL is held by
 * client apps, not admins — a 404 would tell a stale-token holder that a
 * user exists, a 409/503 would leak plane internals, and a client cannot
 * act on any of it. Disabled, expired, unknown, or simply nothing
 * configured all produce the same empty body (the done-when's "empty body
 * rather than an error", generalized). Warnings stay admin-side: the body
 * carries nothing but links.
 */
export async function subscriptionBody(
  env: Env,
  token: string,
): Promise<string> {
  if (!token) {
    return "";
  }
  const user = await db.getUserBySubToken(env.DB, token);
  if (user === null || !isEntitled(user, nowSeconds())) {
    return "";
  }
  const aggregated = await userLinks(env, user.username, user.status);
  return encodeSubscription(aggregated.links.map((link) => link.uri));
}
