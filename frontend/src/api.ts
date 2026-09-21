/**
 * The typed client for the admin API.
 *
 * WHY one request() helper: every page needs the same three things — a
 * parsed body, a human-readable error, and the HTTP status so that a 404
 * can become an empty state instead of a red banner. Centralizing that
 * keeps pages free of fetch details and makes the error shape uniform.
 *
 * WHY non-JSON success bodies are special: Cloudflare Access redirects an
 * expired session to a login page, and fetch follows that redirect to a
 * 200 HTML document. Parsing it as JSON would throw a misleading error, so
 * the client names the likely cause instead.
 *
 * WHY every path is under /api/admin: the Worker's route-group guard is
 * fail-closed to four prefixes, and the SPA must never invent a fifth.
 */

import type {
  InboundSummary,
  LinkProfileIn,
  LinkProfileOut,
  NodeOut,
  NodeRuntimeOut,
  NodeSyncOut,
  OutboundSummary,
  RealityKey,
  StatusOut,
  UserCreateIn,
  UserLinksOut,
  UserOut,
  UserUpdateIn,
} from "./types";

const BASE = "/api/admin";
const SESSION_EXPIRED = "Session may have expired — reload the page.";

/** The uniform result every call returns; `status` lets callers branch on 404. */
export interface ApiResult<T> {
  data: T | null;
  error: string | null;
  status: number;
}

/** Turn a FastAPI error body into one readable line, or null when it has none. */
function detailOf(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("detail" in body)) {
    return null;
  }
  const detail = (body as { detail: unknown }).detail;
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        item && typeof item === "object" && "msg" in item
          ? String((item as { msg: unknown }).msg)
          : JSON.stringify(item),
      )
      .join("; ");
  }
  if (detail) {
    return JSON.stringify(detail);
  }
  return null;
}

/** Perform one request and normalize its body and error into an ApiResult. */
async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch {
    return {
      data: null,
      error: "Network error — is the control plane running?",
      status: 0,
    };
  }
  if (response.status === 204) {
    return { data: null, error: null, status: 204 };
  }
  const text = await response.text();
  let body: unknown = null;
  let parsed = false;
  if (text) {
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      parsed = false;
    }
  }
  if (!response.ok) {
    return {
      data: null,
      error: detailOf(body) ?? `HTTP ${response.status}`,
      status: response.status,
    };
  }
  if (!parsed && text) {
    return { data: null, error: SESSION_EXPIRED, status: response.status };
  }
  return { data: body as T, error: null, status: response.status };
}

/** JSON-stringify a body for the write helpers. */
function json(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

// --- Nodes -----------------------------------------------------------------

export const listNodes = () => request<NodeOut[]>("/nodes");

export const getNode = (nodeId: string) =>
  request<NodeOut>(`/nodes/${encodeURIComponent(nodeId)}`);

export const createNode = (body: {
  id: string;
  label: string;
  address?: string;
}) => request<NodeOut>("/nodes", json(body));

export const updateNode = (
  nodeId: string,
  body: { label?: string; address?: string },
) =>
  request<NodeOut>(`/nodes/${encodeURIComponent(nodeId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const mintNodeToken = (nodeId: string) =>
  request<{ node_id: string; token: string; created_at: number }>(
    `/nodes/${encodeURIComponent(nodeId)}/token`,
    { method: "POST" },
  );

// --- Node state and config -------------------------------------------------

export const getNodeSync = (nodeId: string) =>
  request<NodeSyncOut>(`/nodes/${encodeURIComponent(nodeId)}/sync`);

export const getNodeConfig = (nodeId: string) =>
  request<Record<string, unknown>>(
    `/nodes/${encodeURIComponent(nodeId)}/config`,
  );

export const putNodeConfig = (nodeId: string, config: unknown) =>
  request<{ message: string }>(`/nodes/${encodeURIComponent(nodeId)}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
  });

export const getNodeRuntime = (nodeId: string) =>
  request<NodeRuntimeOut>(
    `/nodes/${encodeURIComponent(nodeId)}/config/runtime`,
  );

export const getNodeInbounds = (nodeId: string) =>
  request<InboundSummary[]>(`/nodes/${encodeURIComponent(nodeId)}/inbounds`);

export const getNodeOutbounds = (nodeId: string) =>
  request<OutboundSummary[]>(`/nodes/${encodeURIComponent(nodeId)}/outbounds`);

// --- REALITY keys ----------------------------------------------------------

export const getNodeReality = (nodeId: string) =>
  request<{ keys: RealityKey[] }>(
    `/nodes/${encodeURIComponent(nodeId)}/reality`,
  );

export const rotateNodeReality = (nodeId: string) =>
  request<{ rotated: string[] }>(
    `/nodes/${encodeURIComponent(nodeId)}/reality/rotate`,
    { method: "POST" },
  );

export const rotateNodeRealityKey = (nodeId: string, tag: string) =>
  request<{ inbound: string; public_key: string | null }>(
    `/nodes/${encodeURIComponent(nodeId)}/reality/${encodeURIComponent(tag)}/rotate`,
    { method: "POST" },
  );

// --- Link profiles ---------------------------------------------------------

export const listNodeProfiles = (nodeId: string) =>
  request<LinkProfileOut[]>(
    `/nodes/${encodeURIComponent(nodeId)}/link-profiles`,
  );

export const createNodeProfile = (nodeId: string, body: LinkProfileIn) =>
  request<LinkProfileOut>(
    `/nodes/${encodeURIComponent(nodeId)}/link-profiles`,
    json(body),
  );

export const updateNodeProfile = (
  nodeId: string,
  profileId: string,
  body: Omit<LinkProfileIn, "id">,
) =>
  request<LinkProfileOut>(
    `/nodes/${encodeURIComponent(nodeId)}/link-profiles/${encodeURIComponent(profileId)}`,
    { method: "PUT", body: JSON.stringify(body) },
  );

export const deleteNodeProfile = (nodeId: string, profileId: string) =>
  request<null>(
    `/nodes/${encodeURIComponent(nodeId)}/link-profiles/${encodeURIComponent(profileId)}`,
    { method: "DELETE" },
  );

// --- Users -----------------------------------------------------------------

export const listUsers = () => request<UserOut[]>("/users");

export const getUser = (username: string) =>
  request<UserOut>(`/users/${encodeURIComponent(username)}`);

export const createUser = (body: UserCreateIn) =>
  request<UserOut>("/users", json(body));

export const updateUser = (username: string, body: UserUpdateIn) =>
  request<UserOut>(`/users/${encodeURIComponent(username)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const deleteUser = (username: string) =>
  request<null>(`/users/${encodeURIComponent(username)}`, { method: "DELETE" });

export const getUserLinks = (username: string) =>
  request<UserLinksOut>(`/users/${encodeURIComponent(username)}/links`);

// --- Status ----------------------------------------------------------------

export const getStatus = () => request<StatusOut>("/status");
