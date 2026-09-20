/**
 * The JSON shapes the admin API returns and accepts.
 *
 * WHY a hand-written mirror of src/models.py: the SPA and the Worker are
 * separate builds in separate languages, so the contract is duplicated by
 * necessity. Keeping every shape in one file makes that duplication
 * reviewable, and the API is frozen for M5, so the mirror is stable.
 */

/** GET /api/admin/nodes — one node as the list/header sees it. */
export interface NodeOut {
  id: string;
  label: string;
  address: string;
  created_at: number;
  has_config: boolean;
}

/** GET /api/admin/nodes/{id}/config/runtime — the live render. */
export interface NodeRuntimeOut {
  config: Record<string, unknown>;
  hash: string;
  warnings: string[];
}

/** GET /api/admin/nodes/{id}/sync — drift plus liveness at a glance. */
export interface NodeSyncOut {
  node_id: string;
  state: "pending" | "active";
  desired_hash: string | null;
  applied_hash: string | null;
  in_sync: boolean;
  last_seen: number | null;
  health: string | null;
  agent_version: string | null;
  xray_version: string | null;
  last_error: string | null;
  warnings: string[];
}

/** One node's access section in a user response (server-generated uuids). */
export interface AccessOut {
  allowed_inbounds: string[];
  allowed_outbounds: string[];
  uuids: Record<string, string>;
}

/** One node's access section in a user write payload (no uuids). */
export interface AccessIn {
  allowed_inbounds: string[];
  allowed_outbounds: string[];
}

/** GET /api/admin/users — one user with per-node access. */
export interface UserOut {
  username: string;
  status: string;
  expire: number | null;
  note: string | null;
  created_at: number;
  access: Record<string, AccessOut>;
}

/** POST /api/admin/users body. */
export interface UserCreateIn {
  username: string;
  status: string;
  expire: number | null;
  note: string | null;
  access: Record<string, AccessIn>;
}

/** PUT /api/admin/users/{username} body (all fields, access authoritative). */
export interface UserUpdateIn {
  status: string;
  expire: number | null;
  note: string | null;
  access: Record<string, AccessIn>;
}

/** One generated VLESS link, carrying its own node. */
export interface ShareLink {
  node: string;
  inbound: string;
  outbound: string;
  email: string;
  profile: string | null;
  label: string | null;
  uri: string;
}

/** GET /api/admin/users/{username}/links. */
export interface UserLinksOut {
  username: string;
  links: ShareLink[];
  warnings: string[];
}

/** GET /api/admin/nodes/{id}/inbounds — one inbound summary. */
export interface InboundSummary {
  tag: string;
  protocol: string;
  network: string;
  security: string;
}

/** GET /api/admin/nodes/{id}/outbounds — one outbound summary. */
export interface OutboundSummary {
  tag: string;
  protocol: string;
}

/** One row of GET /api/admin/nodes/{id}/reality (public key only). */
export interface RealityKey {
  inbound: string;
  public_key: string | null;
  created_at: number | null;
}

/** GET/POST/PUT link profiles: one per-inbound client-side variant. */
export interface LinkProfileOut {
  id: string;
  inbound_tag: string;
  label: string;
  overrides: Record<string, string | number>;
  created_at: number;
}

/** POST/PUT link profiles body. */
export interface LinkProfileIn {
  id: string;
  inbound_tag: string;
  label: string;
  overrides: Record<string, string | number>;
}

/** GET /api/admin/status — the header's cheap composite snapshot. */
export interface StatusOut {
  node_count: number;
  user_count: number;
}
