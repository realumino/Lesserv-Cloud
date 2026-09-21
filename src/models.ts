/**
 * Zod schemas describing the shapes of data entering and leaving the API.
 *
 * WHY this exists: without schemas, endpoints must trust whatever JSON
 * arrives. With Zod, routers validate input (bad data becomes a 422 with a
 * clear error message) and the services never see malformed data. Zod's
 * object default — strip unknown keys — matches Pydantic's ignore-by-
 * default, and `.trim()` plus `refine` reproduces the Python field
 * validators and their messages.
 *
 * The node dimension appears where it belongs: a user's payload carries a
 * nested `access` map keyed by node id, and the server generates the uuids
 * inside each per-node entry — the admin never types a qualified name and
 * never sees storage details.
 *
 * Known limit: JS has a single number type, so a whole-valued JSON float
 * (`443.0`) is indistinguishable from an integer and `z.int()` accepts it,
 * where Pydantic's `StrictInt` rejected it. The API contract and the SPA
 * never send such a value.
 */

import { z } from "zod";

const NODE_ID_PATTERN = /^[a-z0-9]{1,32}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** WHAT: the client-visible URI inputs a link profile may override. */
export const LINK_PROFILE_OVERRIDE_KEYS = new Set([
  "address",
  "alpn",
  "fp",
  "host",
  "mode",
  "path",
  "port",
  "security",
  "serviceName",
  "sni",
]);

/**
 * WHAT: return the first Pydantic-style problem with a username, or null.
 *
 * WHY ordered checks in one function: Pydantic raised the first failing
 * `ValueError`, so a blank-but-long username reports "must not be empty",
 * not both problems.
 */
function usernameIssue(value: string): string | null {
  if (!value) {
    return "username must not be empty";
  }
  if (value.includes("@") || value.includes(" ")) {
    return "username must not contain '@' or spaces";
  }
  if (value.length > 32) {
    return "username must be at most 32 characters";
  }
  return null;
}

/**
 * WHAT: the overrides map every profile schema shares.
 *
 * WHY a shared schema: create and update validate the same value shape;
 * only their null/default handling differs. The refinement reproduces
 * Python's `unsupported override '{key}'` check (the value-type check is
 * already the union below — bools and nulls fail it).
 */
const overridesSchema = z
  .record(z.string(), z.union([z.string(), z.int()]))
  .superRefine((overrides, ctx) => {
    for (const key of Object.keys(overrides)) {
      if (!LINK_PROFILE_OVERRIDE_KEYS.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `unsupported override '${key}'`,
        });
      }
    }
  });

/** WHAT: the JSON body for POST /api/admin/nodes. */
export const NodeCreate = z.object({
  id: z
    .string()
    .trim()
    .refine((value) => NODE_ID_PATTERN.test(value), {
      message: "node id must be 1-32 lowercase letters or digits",
    }),
  label: z
    .string()
    .trim()
    .refine((value) => value !== "", {
      message: "label must not be empty",
    }),
  address: z.string().default(""),
});
export type NodeCreate = z.infer<typeof NodeCreate>;

/**
 * WHAT: the JSON body for PUT /api/admin/nodes/{node_id}.
 *
 * WHY every field is optional: partial update — null means "leave
 * unchanged". No `id`: the id is the identity and cannot be renamed via
 * update.
 */
export const NodeUpdate = z.object({
  label: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
});
export type NodeUpdate = z.infer<typeof NodeUpdate>;

/**
 * WHAT: the JSON the API returns for one node.
 *
 * WHY has_config: a list view must learn which nodes have a config without
 * fetching every config blob.
 */
export const NodeOut = z.object({
  id: z.string(),
  label: z.string(),
  address: z.string(),
  reported_address: z.string().nullable(),
  created_at: z.int(),
  has_config: z.boolean(),
});
export type NodeOut = z.infer<typeof NodeOut>;

/** WHAT: the JSON body for POST /api/admin/nodes/{node_id}/link-profiles. */
export const LinkProfileIn = z.object({
  id: z
    .string()
    .trim()
    .refine((value) => PROFILE_ID_PATTERN.test(value), {
      message:
        "profile id must start with a letter or digit and contain " +
        "only lowercase letters, digits, or hyphens",
    }),
  inbound_tag: z
    .string()
    .trim()
    .refine((value) => value !== "", { message: "value must not be empty" }),
  label: z
    .string()
    .trim()
    .refine((value) => value !== "", { message: "value must not be empty" }),
  overrides: overridesSchema.default(() => ({})),
});
export type LinkProfileIn = z.infer<typeof LinkProfileIn>;

/**
 * WHAT: the JSON body for PUT .../link-profiles/{profile_id}.
 *
 * WHY every editable field is optional: null means unchanged. Identity
 * fields are never renamed through an update.
 */
export const LinkProfileUpdate = z.object({
  inbound_tag: z
    .string()
    .trim()
    .refine((value) => value !== "", { message: "value must not be empty" })
    .nullable()
    .default(null),
  label: z
    .string()
    .trim()
    .refine((value) => value !== "", { message: "value must not be empty" })
    .nullable()
    .default(null),
  overrides: overridesSchema.nullable().default(null),
});
export type LinkProfileUpdate = z.infer<typeof LinkProfileUpdate>;

/** WHAT: the JSON the API returns for one link profile. */
export const LinkProfileOut = z.object({
  id: z.string(),
  inbound_tag: z.string(),
  label: z.string(),
  overrides: z.record(z.string(), z.union([z.string(), z.int()])),
  created_at: z.int(),
});
export type LinkProfileOut = z.infer<typeof LinkProfileOut>;

/**
 * WHAT: one node's section of a user's access payload.
 *
 * WHY lists and not the uuid map: uuids are server-generated facts; the
 * client only chooses which local inbounds and outbounds are allowed.
 */
export const AccessIn = z.object({
  allowed_inbounds: z.array(z.string()).default(() => []),
  allowed_outbounds: z.array(z.string()).default(() => []),
});
export type AccessIn = z.infer<typeof AccessIn>;

/** WHAT: the JSON body for POST /api/admin/users. */
export const UserCreate = z.object({
  username: z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const message = usernameIssue(value);
      if (message !== null) {
        ctx.addIssue({ code: "custom", message });
      }
    }),
  status: z.enum(["active", "disabled"]).default("active"),
  expire: z.int().nullable().default(null),
  note: z.string().nullable().default(null),
  access: z.record(z.string(), AccessIn).default(() => ({})),
});
export type UserCreate = z.infer<typeof UserCreate>;

/**
 * WHAT: the JSON body for PUT /api/admin/users/{username}.
 *
 * WHY access is optional: null means "leave access unchanged"; a provided
 * map is the complete desired membership — nodes left out of it lose their
 * row (the admin form submits every per-node section).
 */
export const UserUpdate = z.object({
  status: z.enum(["active", "disabled"]).nullable().default(null),
  expire: z.int().nullable().default(null),
  note: z.string().nullable().default(null),
  access: z.record(z.string(), AccessIn).nullable().default(null),
});
export type UserUpdate = z.infer<typeof UserUpdate>;

/** WHAT: one node's section of a response, with server-generated uuids. */
export const AccessOut = z.object({
  allowed_inbounds: z.array(z.string()),
  allowed_outbounds: z.array(z.string()),
  uuids: z.record(z.string(), z.string()),
});
export type AccessOut = z.infer<typeof AccessOut>;

/**
 * WHAT: the JSON the API returns for one user.
 *
 * WHY access is nested by node: membership is per-node stored data; the
 * admin sees exactly the shape they edit. WHY sub_token rides along: the
 * SPA builds the subscription URL from it, and a second GET would be a
 * round trip for a field the row already carries. Plaintext, like storage.
 */
export const UserOut = z.object({
  username: z.string(),
  status: z.string(),
  expire: z.int().nullable(),
  note: z.string().nullable(),
  sub_token: z.string().nullable(),
  sub_token_created_at: z.int().nullable(),
  created_at: z.int(),
  access: z.record(z.string(), AccessOut),
});
export type UserOut = z.infer<typeof UserOut>;

/**
 * WHAT: response for POST /api/admin/users/{username}/sub-token.
 *
 * WHY the plaintext appears here: the URL is the product — shown on every
 * rotation (and once at create time, which is also a rotation), stored
 * plaintext, never returned by any other endpoint.
 */
export const SubTokenOut = z.object({
  username: z.string(),
  sub_token: z.string(),
  created_at: z.int(),
});
export type SubTokenOut = z.infer<typeof SubTokenOut>;

/** WHAT: one generated VLESS share link, carrying its own node. */
export const ShareLink = z.object({
  node: z.string(),
  inbound: z.string(),
  outbound: z.string(),
  email: z.string(),
  profile: z.string().nullable().default(null),
  label: z.string().nullable().default(null),
  uri: z.string(),
});
export type ShareLink = z.infer<typeof ShareLink>;

/** WHAT: response for GET /api/admin/users/{username}/links. */
export const UserLinksOut = z.object({
  username: z.string(),
  links: z.array(ShareLink),
  warnings: z.array(z.string()),
});
export type UserLinksOut = z.infer<typeof UserLinksOut>;

/**
 * WHAT: response for POST /api/admin/nodes/{node_id}/token.
 *
 * WHY the plaintext appears here and nowhere else: it is shown once at
 * mint time; afterwards only its hash exists in the database.
 */
export const TokenOut = z.object({
  node_id: z.string(),
  token: z.string(),
  created_at: z.int(),
});
export type TokenOut = z.infer<typeof TokenOut>;

/** WHAT: request body for POST /api/node/enroll (PROTOCOL.md, protocol 1). */
export const EnrollIn = z.object({
  protocol: z.int(),
  agent_version: z.string().default(""),
  xray_version: z.string().default(""),
  platform: z.string().default(""),
  detected_ip: z.string().nullable().default(null),
});
export type EnrollIn = z.infer<typeof EnrollIn>;

/**
 * WHAT: request body for POST /api/node/heartbeat (PROTOCOL.md, protocol 1).
 *
 * WHY every fact but `protocol` is optional: the heartbeat must stay cheap
 * and forward-compatible — a missing field means "no report", never a
 * failure. The plane only stores versions + applied hash; running state is
 * liveness context for this request alone.
 */
export const HeartbeatIn = z.object({
  protocol: z.int(),
  applied_hash: z.string().nullable().default(null),
  applied_at: z.int().nullable().default(null),
  xray_running: z.boolean().default(false),
  xray_pid: z.int().nullable().default(null),
  agent_uptime: z.int().nullable().default(null),
  last_error: z.string().nullable().default(null),
});
export type HeartbeatIn = z.infer<typeof HeartbeatIn>;

/** WHAT: request body for POST /api/node/report (PROTOCOL.md, protocol 1). */
export const ReportIn = z.object({
  protocol: z.int(),
  hash: z.string(),
  ok: z.boolean(),
  stage: z.enum(["fetched", "test", "applied", "started", "rolled_back"]),
  xray_exit_code: z.int().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type ReportIn = z.infer<typeof ReportIn>;

/**
 * WHAT: request body for POST /api/node/stats (PROTOCOL.md, protocol 1).
 *
 * WHY validated then discarded today: the agent ships absolute counters
 * from v1 so history can accumulate, but accumulation (`node_stats`) does
 * not exist yet. Accepting the shape now keeps the agent releasable
 * without pretending to store anything.
 */
export const StatsIn = z.object({
  protocol: z.int(),
  boot_id: z.string(),
  counters: z
    .record(z.string(), z.int())
    .default(() => ({}))
    .superRefine((counters, ctx) => {
      for (const [key, value] of Object.entries(counters)) {
        if (value < 0) {
          ctx.addIssue({
            code: "custom",
            message: `counter '${key}' must be non-negative`,
          });
        }
      }
    }),
});
export type StatsIn = z.infer<typeof StatsIn>;

/**
 * WHAT: the error a router throws for a non-2xx `{detail}` response.
 *
 * WHY one class: Python raised `HTTPException(status, detail)` everywhere
 * and one exception handler rendered the envelope; the port keeps that
 * single seam. `detail` is a string for semantic errors and a list (of
 * `{msg}` objects or strings) for validation errors, exactly the body
 * `frontend/src/api.ts` already parses. The class lives here because it is
 * part of the API contract the schemas describe.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : "request failed");
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * WHAT: parse and validate a JSON request body, or throw the 422 envelope.
 *
 * WHY here and not per router: the malformed-JSON catch and the Zod-issue
 * formatting are identical for every endpoint, and FastAPI rendered both
 * as `{detail: [{msg: ...}]}`. Non-JSON bodies are a 422 with the same
 * message FastAPI used, so the SPA's error line never changes.
 */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(422, [{ msg: "JSON decode error" }]);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      422,
      parsed.error.issues.map((issue) => ({ msg: issue.message })),
    );
  }
  return parsed.data;
}

/**
 * WHAT: parse an arbitrary JSON object body (the opaque node config).
 *
 * WHY separate from `parseJsonBody`: the config is deliberately schema-less;
 * only "a JSON object" is required, matching FastAPI's `dict` body type.
 * Everything else (arrays, scalars, null) is the same 422 as Python.
 */
export async function parseJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(422, [{ msg: "JSON decode error" }]);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(422, [{ msg: "Input should be a valid dictionary" }]);
  }
  return body as Record<string, unknown>;
}

/** WHAT: response for GET /api/admin/nodes/{node_id}/sync: drift at a glance. */
export const NodeSyncOut = z.object({
  node_id: z.string(),
  state: z.enum(["pending", "active"]),
  desired_hash: z.string().nullable(),
  applied_hash: z.string().nullable(),
  in_sync: z.boolean(),
  last_seen: z.int().nullable(),
  health: z.string().nullable(),
  agent_version: z.string().nullable(),
  xray_version: z.string().nullable(),
  last_error: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type NodeSyncOut = z.infer<typeof NodeSyncOut>;
