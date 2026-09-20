/**
 * All database access lives behind this module.
 *
 * D1 is the only backend, and this file is the only place it is spoken to.
 * Callers pass the `env.DB` binding in explicitly and never see SQL: every
 * function here takes `(db, ...)` and returns plain decoded objects.
 *
 * WHY async everywhere: D1 has no synchronous API, so every read and write
 * is a promise. The asymmetry is the convention, not an accident: pure code
 * (core/, the pure services) stays synchronous; anything that touches a
 * binding is async.
 *
 * WHY this is the only file containing SQL: the data model lives in
 * `migrations/*.sql`, but every query that reads or writes it lives here,
 * so schema and access patterns are findable in exactly two places. Reads
 * use `.all()` (rows), writes use `.run()` (nothing to return).
 *
 * There is no second backend and no fallback: the app runs only under
 * workerd, and the binding is typed and present or the request never
 * reaches a handler.
 */

/** WHAT: one raw row as D1 hands it back (column name -> storage value). */
export type Row = Record<string, unknown>;

/** WHAT: a value D1 accepts as a bound parameter. */
type Param = string | number | null;

/** WHAT: one node row, with the opaque config already decoded. */
export type NodeRow = {
  id: string;
  label: string;
  address: string;
  reported_address: string | null;
  config_json: Record<string, unknown> | null;
  token_hash: string | null;
  applied_hash: string | null;
  last_seen: number | null;
  health: string | null;
  agent_version: string | null;
  xray_version: string | null;
  last_error: string | null;
  created_at: number;
};

/** WHAT: one global user row. */
export type UserRow = {
  username: string;
  status: string;
  expire: number | null;
  note: string | null;
  created_at: number;
};

/** WHAT: one (user, node) access row with its JSON columns decoded. */
export type AccessRow = {
  username: string;
  node_id: string;
  allowed_inbounds: string[];
  allowed_outbounds: string[];
  uuids: Record<string, string>;
};

/** WHAT: one stored REALITY key row (the columns `listRealityKeys` reads). */
export type RealityKeyRow = {
  inbound_tag: string;
  private_key: string;
  created_at: number;
};

/** WHAT: one link-profile row with its overrides decoded. */
export type LinkProfileRow = {
  node_id: string;
  id: string;
  inbound_tag: string;
  label: string;
  overrides: Record<string, string | number>;
  created_at: number;
};

const ACCESS_JSON_COLS = ["allowed_inbounds", "allowed_outbounds", "uuids"];
const PROFILE_JSON_COLS = ["overrides"];

/**
 * WHAT: run one read statement and return all rows.
 *
 * WHY a helper per direction: reads need `.all()` and writes need `.run()`,
 * and keeping that split in two three-line helpers means no caller ever
 * chooses the wrong one.
 */
async function selectRows(
  db: D1Database,
  sql: string,
  params: Param[] = [],
): Promise<Row[]> {
  const result = await db.prepare(sql).bind(...params).all();
  return (result.results ?? []) as Row[];
}

/** WHAT: run one write statement, discarding its meta. */
async function executeWrite(
  db: D1Database,
  sql: string,
  params: Param[] = [],
): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

/**
 * WHAT: decode JSON-text columns of one row into real structures.
 *
 * WHY this lives here: SQLite (and D1) have no list/dict column types, so
 * lists and maps are stored as JSON text; this is the single spot that
 * turns them back into real structures.
 */
export function rowToDictWithJson(row: Row, jsonCols: readonly string[]): Row {
  const decoded = { ...row };
  for (const col of jsonCols) {
    decoded[col] = JSON.parse(decoded[col] as string) as unknown;
  }
  return decoded;
}

/**
 * WHAT: decode one node row; `config_json` NULL means "no config yet".
 *
 * WHY decode here and not in callers: the config blob is opaque, but
 * "is it set?" is a decision every node endpoint makes, and a decoded
 * object (or null) is the shape the service layer compares against.
 */
function nodeRow(row: Row): NodeRow {
  const node = { ...row } as unknown as NodeRow;
  node.config_json =
    row["config_json"] === null || row["config_json"] === undefined
      ? null
      : (JSON.parse(row["config_json"] as string) as Record<string, unknown>);
  return node;
}

/** WHAT: decode one access row's JSON columns into real lists/dicts. */
function accessRow(row: Row): AccessRow {
  return rowToDictWithJson(row, ACCESS_JSON_COLS) as unknown as AccessRow;
}

/** WHAT: decode one link-profile row's JSON overrides into a real object. */
function profileRow(row: Row): LinkProfileRow {
  return rowToDictWithJson(row, PROFILE_JSON_COLS) as unknown as LinkProfileRow;
}

/** WHAT: return every node, id-ordered (deterministic lists for the UI). */
export async function listNodes(db: D1Database): Promise<NodeRow[]> {
  const rows = await selectRows(db, "SELECT * FROM nodes ORDER BY id");
  return rows.map(nodeRow);
}

/** WHAT: fetch one node by id, or null when missing. */
export async function getNode(
  db: D1Database,
  nodeId: string,
): Promise<NodeRow | null> {
  const rows = await selectRows(db, "SELECT * FROM nodes WHERE id = ?", [nodeId]);
  return rows.length > 0 ? nodeRow(rows[0] as Row) : null;
}

/**
 * WHAT: insert one complete node row (server-generated fields included).
 *
 * WHY it takes a complete object: deciding what values a new node gets is
 * business logic that belongs to the service layer; this function only
 * knows how to store what it is given. Agent-facing columns start as NULL —
 * nothing is filled until an agent reports.
 */
export async function createNode(
  db: D1Database,
  node: {
    id: string;
    label: string;
    address: string;
    created_at: number;
    config_json?: Record<string, unknown> | null;
  },
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO nodes (id, label, address, config_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        `,
    [
      node.id,
      node.label,
      node.address,
      node.config_json != null ? JSON.stringify(node.config_json) : null,
      node.created_at,
    ],
  );
}

/**
 * WHAT: overwrite the editable columns (label, address) of one node.
 *
 * WHY label/address only: the id is the identity (never renamed via update)
 * and `config_json` has its own setter — `setNodeConfig` — because saving a
 * config is a distinct act that also triggers a sync.
 */
export async function replaceNode(
  db: D1Database,
  node: { id: string; label: string; address: string },
): Promise<void> {
  await executeWrite(db, "UPDATE nodes SET label = ?, address = ? WHERE id = ?", [
    node.label,
    node.address,
    node.id,
  ]);
}

/**
 * WHAT: store (or clear, with null) one node's opaque authored config.
 *
 * WHY JSON text: the config is an object the plane never interprets; it is
 * stored verbatim so a render reads back exactly what was pasted.
 */
export async function setNodeConfig(
  db: D1Database,
  nodeId: string,
  config: Record<string, unknown> | null,
): Promise<void> {
  const text = config !== null ? JSON.stringify(config) : null;
  await executeWrite(db, "UPDATE nodes SET config_json = ? WHERE id = ?", [
    text,
    nodeId,
  ]);
}

/**
 * WHAT: store one node's bearer-token hash, replacing any previous one.
 *
 * WHY a replace and not a history: rotation invalidates immediately — the
 * old hash dies the moment the new one is stored, so there is exactly one
 * valid token per node at any time.
 */
export async function setTokenHash(
  db: D1Database,
  nodeId: string,
  tokenHash: string,
): Promise<void> {
  await executeWrite(db, "UPDATE nodes SET token_hash = ? WHERE id = ?", [
    tokenHash,
    nodeId,
  ]);
}

/**
 * WHAT: store one node's agent-reported address (display only, never links).
 *
 * WHY a dedicated setter: the reported address is a fact the node states
 * about itself at enroll, not editable state like label and address.
 * Keeping it out of `replaceNode` makes the split impossible to blur — the
 * admin owns the share-link domain, the node owns its own report.
 */
export async function setReportedAddress(
  db: D1Database,
  nodeId: string,
  address: string | null,
): Promise<void> {
  await executeWrite(db, "UPDATE nodes SET reported_address = ? WHERE id = ?", [
    address,
    nodeId,
  ]);
}

/**
 * WHAT: overwrite one node's agent-reported liveness columns in one statement.
 *
 * WHY one fixed statement: the service layer computes the complete desired
 * values first (including the heartbeat cheap-write decision), so the SQL
 * never needs a dynamic column list — same reasoning as `replaceUser`.
 * `last_seen` NULL means "never contacted" (pending).
 */
export async function touchNode(
  db: D1Database,
  nodeId: string,
  lastSeen: number | null,
  health: string | null,
  agentVersion: string | null,
  xrayVersion: string | null,
  lastError: string | null,
  appliedHash: string | null,
): Promise<void> {
  await executeWrite(
    db,
    `
        UPDATE nodes
        SET last_seen = ?, health = ?, agent_version = ?,
            xray_version = ?, last_error = ?, applied_hash = ?
        WHERE id = ?
        `,
    [lastSeen, health, agentVersion, xrayVersion, lastError, appliedHash, nodeId],
  );
}

/** WHAT: return every user's global row, username-ordered. */
export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const rows = await selectRows(db, "SELECT * FROM users ORDER BY username");
  return rows as unknown as UserRow[];
}

/**
 * WHAT: fetch one user's global row by username, or null when not found.
 *
 * WHY global fields only: status/expire/note are user-wide; the per-node
 * access lives in `user_node_access` and is joined by the services that
 * need it.
 */
export async function getUser(
  db: D1Database,
  username: string,
): Promise<UserRow | null> {
  const rows = await selectRows(db, "SELECT * FROM users WHERE username = ?", [
    username,
  ]);
  return rows.length > 0 ? (rows[0] as unknown as UserRow) : null;
}

/** WHAT: insert the global user row (identity and server facts only). */
export async function createUser(
  db: D1Database,
  user: {
    username: string;
    status: string;
    expire: number | null;
    note: string | null;
    created_at: number;
  },
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO users (username, status, expire, note, created_at)
        VALUES (?, ?, ?, ?, ?)
        `,
    [user.username, user.status, user.expire, user.note, user.created_at],
  );
}

/**
 * WHAT: overwrite the editable global columns of one user row.
 *
 * WHY a full overwrite of just these columns: the service layer merges
 * partial changes first, so this stays one fixed SQL statement with no
 * dynamic column list — same reasoning as the archived panel.
 */
export async function replaceUser(
  db: D1Database,
  user: { username: string; status: string; expire: number | null; note: string | null },
): Promise<void> {
  await executeWrite(
    db,
    "UPDATE users SET status = ?, expire = ?, note = ? WHERE username = ?",
    [user.status, user.expire, user.note, user.username],
  );
}

/**
 * WHAT: delete one user's access rows and then the user row.
 *
 * WHY access rows first: removing children first means the worst failure
 * case is an orphaned user with no access, never an access row pointing at
 * a missing user.
 */
export async function deleteUser(
  db: D1Database,
  username: string,
): Promise<void> {
  await executeWrite(db, "DELETE FROM user_node_access WHERE username = ?", [
    username,
  ]);
  await executeWrite(db, "DELETE FROM users WHERE username = ?", [username]);
}

/** WHAT: return one user's access rows, node-id ordered (deterministic). */
export async function listAccessForUser(
  db: D1Database,
  username: string,
): Promise<AccessRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM user_node_access WHERE username = ? ORDER BY node_id",
    [username],
  );
  return rows.map(accessRow);
}

/**
 * WHAT: return one node's access rows, username-ordered.
 *
 * WHY username order: the render pipeline consumes this list directly; a
 * deterministic order is what makes two renders of the same database state
 * byte-identical, which content-hash convergence needs.
 */
export async function listAccessForNode(
  db: D1Database,
  nodeId: string,
): Promise<AccessRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM user_node_access WHERE node_id = ? ORDER BY username",
    [nodeId],
  );
  return rows.map(accessRow);
}

/**
 * WHAT: fetch one (user, node) access row, or null when there is none.
 *
 * WHY it exists: the uuid rule needs the row's existing uuid map to keep
 * pairs stable across edits — only genuinely new outbound tags mint a uuid.
 */
export async function getAccess(
  db: D1Database,
  username: string,
  nodeId: string,
): Promise<AccessRow | null> {
  const rows = await selectRows(
    db,
    "SELECT * FROM user_node_access WHERE username = ? AND node_id = ?",
    [username, nodeId],
  );
  return rows.length > 0 ? accessRow(rows[0] as Row) : null;
}

/**
 * WHAT: insert or replace one (user, node) access row.
 *
 * WHY replace and not a partial update: the service layer computes the
 * complete desired row (existing uuids merged with new ones) first, so the
 * SQL stays one fixed statement. `ON CONFLICT` covers both first membership
 * and re-saving an existing one.
 */
export async function upsertAccess(
  db: D1Database,
  username: string,
  nodeId: string,
  allowedInbounds: string[],
  allowedOutbounds: string[],
  uuids: Record<string, string>,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO user_node_access
            (username, node_id, allowed_inbounds, allowed_outbounds, uuids)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(username, node_id) DO UPDATE SET
            allowed_inbounds = excluded.allowed_inbounds,
            allowed_outbounds = excluded.allowed_outbounds,
            uuids = excluded.uuids
        `,
    [
      username,
      nodeId,
      JSON.stringify(allowedInbounds),
      JSON.stringify(allowedOutbounds),
      JSON.stringify(uuids),
    ],
  );
}

/** WHAT: remove one (user, node) access row; a missing row is not an error. */
export async function deleteAccess(
  db: D1Database,
  username: string,
  nodeId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM user_node_access WHERE username = ? AND node_id = ?",
    [username, nodeId],
  );
}

/**
 * WHAT: return one node's REALITY keys as {inbound_tag: key row}.
 *
 * WHY keyed by tag: an inbound's tag is its identity within a node's
 * config, so the key follows the tag — removing and re-adding an inbound
 * with the same tag reuses its key instead of breaking clients.
 */
export async function listRealityKeys(
  db: D1Database,
  nodeId: string,
): Promise<Record<string, RealityKeyRow>> {
  const rows = await selectRows(
    db,
    "SELECT inbound_tag, private_key, created_at FROM reality_keys WHERE node_id = ?",
    [nodeId],
  );
  const keys: Record<string, RealityKeyRow> = {};
  for (const row of rows) {
    keys[row["inbound_tag"] as string] = row as unknown as RealityKeyRow;
  }
  return keys;
}

/**
 * WHAT: insert or overwrite one node's key for one inbound tag.
 *
 * WHY an upsert: generation (first key for a tag) and rotation (fresh key
 * for an existing tag) are the same storage operation — replace whatever is
 * stored with the given key and timestamp.
 */
export async function upsertRealityKey(
  db: D1Database,
  nodeId: string,
  inboundTag: string,
  privateKey: string,
  createdAt: number,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO reality_keys (node_id, inbound_tag, private_key, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(node_id, inbound_tag) DO UPDATE SET
            private_key = excluded.private_key,
            created_at = excluded.created_at
        `,
    [nodeId, inboundTag, privateKey, createdAt],
  );
}

/** WHAT: return one node's link profiles in deterministic display order. */
export async function listLinkProfiles(
  db: D1Database,
  nodeId: string,
): Promise<LinkProfileRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM link_profiles WHERE node_id = ? ORDER BY inbound_tag, id",
    [nodeId],
  );
  return rows.map(profileRow);
}

/** WHAT: fetch one link profile by node and slug, or null when missing. */
export async function getLinkProfile(
  db: D1Database,
  nodeId: string,
  profileId: string,
): Promise<LinkProfileRow | null> {
  const rows = await selectRows(
    db,
    "SELECT * FROM link_profiles WHERE node_id = ? AND id = ?",
    [nodeId, profileId],
  );
  return rows.length > 0 ? profileRow(rows[0] as Row) : null;
}

/** WHAT: insert one complete link-profile row (server facts included). */
export async function createLinkProfile(
  db: D1Database,
  profile: LinkProfileRow,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO link_profiles
            (node_id, id, inbound_tag, label, overrides, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
    [
      profile.node_id,
      profile.id,
      profile.inbound_tag,
      profile.label,
      JSON.stringify(profile.overrides),
      profile.created_at,
    ],
  );
}

/**
 * WHAT: overwrite one profile's inbound, label, and overrides.
 *
 * WHY a fixed update: the service merges partial changes first, so SQL
 * stays one statement. Identity columns are never changed here.
 */
export async function updateLinkProfile(
  db: D1Database,
  profile: LinkProfileRow,
): Promise<void> {
  await executeWrite(
    db,
    `
        UPDATE link_profiles
        SET inbound_tag = ?, label = ?, overrides = ?
        WHERE node_id = ? AND id = ?
        `,
    [
      profile.inbound_tag,
      profile.label,
      JSON.stringify(profile.overrides),
      profile.node_id,
      profile.id,
    ],
  );
}

/** WHAT: remove one link profile; a missing row is not an error. */
export async function deleteLinkProfile(
  db: D1Database,
  nodeId: string,
  profileId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM link_profiles WHERE node_id = ? AND id = ?",
    [nodeId, profileId],
  );
}
