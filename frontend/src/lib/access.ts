/**
 * The pure model behind the user form's per-node access editor.
 *
 * WHY this is a separate, tested module: the access map a user form
 * submits is *authoritative* — a node left out of it loses its access row
 * on the server. That makes "which nodes are in the payload" the riskiest
 * piece of frontend logic in the app, so it lives here as plain functions
 * with no React and no fetch, and the vitest suite pins it.
 *
 * The rule the admin should never have to remember: sections are keyed and
 * labelled by node, and the tags inside are the local names the admin
 * authored (`reality`, `niigata`) — never a qualified name.
 */

import type { AccessIn, AccessOut, NodeOut } from "../types";

/** One node's section in the access editor. */
export interface NodeAccessSection {
  authorized: boolean;
  allowedInbounds: string[];
  allowedOutbounds: string[];
}

/** The whole form's access state, keyed by node id. */
export type AccessForm = Record<string, NodeAccessSection>;

/** Build a form with every node present but unauthorized (create mode). */
export function emptyAccessForm(nodes: NodeOut[]): AccessForm {
  const form: AccessForm = {};
  for (const node of nodes) {
    form[node.id] = {
      authorized: false,
      allowedInbounds: [],
      allowedOutbounds: [],
    };
  }
  return form;
}

/** Build a form from an existing user, marking the nodes they belong to.
 *
 * WHY only nodes in the list: the payload's keys must be nodes that still
 * exist (a stale access row would 404 the save); the node list is the
 * authority for what exists. Stored tag names are copied verbatim so an
 * edit never silently drops access to a tag the config UI cannot show.
 */
export function formFromUser(
  user: { access: Record<string, AccessOut> },
  nodes: NodeOut[],
): AccessForm {
  const form: AccessForm = {};
  for (const node of nodes) {
    const entry = user.access[node.id];
    form[node.id] = entry
      ? {
          authorized: true,
          allowedInbounds: [...entry.allowed_inbounds],
          allowedOutbounds: [...entry.allowed_outbounds],
        }
      : { authorized: false, allowedInbounds: [], allowedOutbounds: [] };
  }
  return form;
}

/** Flip one node's membership without touching its tag selections. */
export function toggleNode(form: AccessForm, nodeId: string): AccessForm {
  const section = form[nodeId];
  if (!section) {
    return form;
  }
  return { ...form, [nodeId]: { ...section, authorized: !section.authorized } };
}

/** Add or remove one local tag from one node's inbound or outbound list. */
export function toggleTag(
  form: AccessForm,
  nodeId: string,
  list: "inbound" | "outbound",
  tag: string,
): AccessForm {
  const section = form[nodeId];
  if (!section) {
    return form;
  }
  const key = list === "inbound" ? "allowedInbounds" : "allowedOutbounds";
  const current = section[key];
  const next = current.includes(tag)
    ? current.filter((item) => item !== tag)
    : [...current, tag];
  return { ...form, [nodeId]: { ...section, [key]: next } };
}

/** Convert the form into the authoritative access payload.
 *
 * WHY unauthorized nodes are omitted: their absence is what deletes the
 * server-side access row. An authorized node with empty lists is still a
 * member — it simply has nothing allocated yet.
 */
export function toAccessPayload(form: AccessForm): Record<string, AccessIn> {
  const payload: Record<string, AccessIn> = {};
  for (const [nodeId, section] of Object.entries(form)) {
    if (!section.authorized) {
      continue;
    }
    payload[nodeId] = {
      allowed_inbounds: [...section.allowedInbounds],
      allowed_outbounds: [...section.allowedOutbounds],
    };
  }
  return payload;
}
