/**
 * Business rules for users: uuid generation and per-node access rows.
 *
 * WHY this layer exists: routers do HTTP, `db` does SQL; the rules — how
 * uuids are minted per (user, node, exit), what an access update means —
 * live here. Mutations only write rows: each node's agent picks the new
 * render up on its next heartbeat (content-hash convergence).
 */

import { base64UrlEncode } from "../core/x25519";
import * as db from "../db";
import type {
  AccessIn,
  AccessOut,
  SubTokenOut,
  UserCreate,
  UserOut,
  UserUpdate,
} from "../models";

/** WHAT: Unix seconds from the plane's clock (the time authority). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const SUB_TOKEN_BYTES = 32;

/**
 * WHAT: mint one 32-byte random subscription token, base64url-encoded.
 *
 * WHY 256 bits in plaintext: the token is the capability URL itself — the
 * admin must be able to re-display it, so it is never hashed (a dump already
 * contains every UUID, so hashing would protect nothing). High entropy is
 * what makes plaintext safe: the unique-index lookup cannot be brute-forced
 * or timed, which is why the node token's hash-and-compare rules do not
 * apply here. Drawn inside request handlers only (no module-scope entropy).
 */
export function mintSubToken(): string {
  return base64UrlEncode(
    crypto.getRandomValues(new Uint8Array(SUB_TOKEN_BYTES)),
  );
}

/**
 * WHAT: return true when the user may receive subscription links right now.
 *
 * WHY a pure function: `/sub` must decide entitlement identically on every
 * request without touching config or access rows, and the rule has edge
 * cases worth unit-testing: `expire` null or 0 means "never expires" (0 is
 * the stored convention for never, matching the UI's fmtExpire), a timestamp
 * at or before `at` means expired, and anything but `status: "active"` is
 * out. Rendering and the admin links view never consult this — disabling a
 * user removes their links from the *subscription*, exactly as the render
 * removes them from the nodes.
 */
export function isEntitled(
  user: { status: string; expire: number | null },
  at: number,
): boolean {
  if (user.status !== "active") {
    return false;
  }
  if (user.expire === null || user.expire === 0) {
    return true;
  }
  return user.expire > at;
}

/**
 * WHAT: return a copy of `uuids` with an entry for every outbound tag.
 *
 * WHY tag-keyed (the archived panel keyed by full email): uuids are stored
 * per (user, node), so the username part of the email would be redundant
 * storage; the render projection rebuilds the email. Existing tags keep
 * their uuid — configs already shared with a user keep working after edits;
 * only genuinely new pairs get a fresh uuid. Pure function, no database,
 * which makes it trivial to test.
 */
export function ensureUuids(
  outboundTags: string[],
  uuids: Record<string, string>,
): Record<string, string> {
  const result = { ...uuids };
  for (const tag of outboundTags) {
    if (!Object.hasOwn(result, tag)) {
      result[tag] = crypto.randomUUID();
    }
  }
  return result;
}

/**
 * WHAT: return the UserOut-shaped object (nested access), or null.
 *
 * WHY a projection instead of a db function: the nesting is response shape,
 * not storage shape; db returns flat rows and this is the single place the
 * two meet.
 */
export async function getUserWithAccess(
  conn: D1Database,
  username: string,
): Promise<UserOut | null> {
  const user = await db.getUser(conn, username);
  if (user === null) {
    return null;
  }
  const access: Record<string, AccessOut> = {};
  for (const row of await db.listAccessForUser(conn, username)) {
    access[row.node_id] = {
      allowed_inbounds: row.allowed_inbounds,
      allowed_outbounds: row.allowed_outbounds,
      uuids: row.uuids,
    };
  }
  return { ...user, access };
}

/** WHAT: return every user in the UserOut shape. */
export async function listUsersWithAccess(
  conn: D1Database,
): Promise<UserOut[]> {
  const users: UserOut[] = [];
  for (const row of await db.listUsers(conn)) {
    users.push((await getUserWithAccess(conn, row.username)) as UserOut);
  }
  return users;
}

/**
 * WHAT: upsert one access row per listed node, minting missing uuids.
 *
 * WHY uuids are merged, not replaced: an existing (user, node, outbound)
 * pair keeps its uuid (stability), only new outbound tags mint one — the
 * archived ensure_uuids rule, applied per node.
 */
async function writeAccess(
  conn: D1Database,
  username: string,
  access: Record<string, AccessIn>,
): Promise<void> {
  for (const nodeId of Object.keys(access).sort()) {
    const entry = access[nodeId] as AccessIn;
    const existing = await db.getAccess(conn, username, nodeId);
    const uuids = ensureUuids(
      entry.allowed_outbounds,
      existing !== null ? existing.uuids : {},
    );
    await db.upsertAccess(
      conn,
      username,
      nodeId,
      entry.allowed_inbounds,
      entry.allowed_outbounds,
      uuids,
    );
  }
}

/**
 * WHAT: turn a UserCreate payload into a user row plus per-node access rows.
 *
 * WHY the service fills uuids and created_at: they are server-generated
 * facts, not client choices. Nothing is pushed after storing — the affected
 * nodes converge on their next heartbeat.
 */
export async function createUser(
  conn: D1Database,
  data: UserCreate,
): Promise<UserOut> {
  const mintedAt = nowSeconds();
  await db.createUser(conn, {
    username: data.username,
    status: data.status,
    expire: data.expire,
    note: data.note,
    sub_token: mintSubToken(),
    sub_token_created_at: mintedAt,
    created_at: mintedAt,
  });
  await writeAccess(conn, data.username, data.access);
  return (await getUserWithAccess(conn, data.username)) as UserOut;
}

/**
 * WHAT: merge a partial update; a provided access map is authoritative.
 *
 * WHY authoritative membership: the admin form submits every per-node
 * section at once, so the payload is the complete desired state — nodes
 * left out of it lose their row. `access: null` means "leave access
 * unchanged". Returns the updated user, or null when the user does not
 * exist (the router maps to 404).
 */
export async function updateUser(
  conn: D1Database,
  username: string,
  data: UserUpdate,
): Promise<UserOut | null> {
  const existing = await db.getUser(conn, username);
  if (existing === null) {
    return null;
  }
  if (data.status !== null) {
    existing.status = data.status;
  }
  if (data.expire !== null) {
    existing.expire = data.expire;
  }
  if (data.note !== null) {
    existing.note = data.note;
  }
  await db.replaceUser(conn, existing);

  if (data.access !== null) {
    const oldNodes = new Set(
      (await db.listAccessForUser(conn, username)).map((row) => row.node_id),
    );
    const keptNodes = new Set(Object.keys(data.access));
    for (const nodeId of [...oldNodes].sort()) {
      if (!keptNodes.has(nodeId)) {
        await db.deleteAccess(conn, username, nodeId);
      }
    }
    await writeAccess(conn, username, data.access);
  }
  return getUserWithAccess(conn, username);
}

/**
 * WHAT: remove a user and their access rows; true when they existed.
 *
 * WHY the existence check comes first: the caller maps "nothing deleted" to
 * a 404, and a 404 must not touch anything else.
 */
export async function deleteUser(
  conn: D1Database,
  username: string,
): Promise<boolean> {
  if ((await db.getUser(conn, username)) === null) {
    return false;
  }
  await db.deleteUser(conn, username);
  return true;
}

/**
 * WHAT: mint and store a fresh subscription token; null when user missing.
 *
 * WHY replace, not generate-once: rotation is the revocation path — the old
 * URL dies the instant the new token is stored, so a leaked URL is fixed
 * with one POST and no other state changes. Pre-M6 rows (null token) get
 * their first token through the same call, which is why it is "mint or
 * rotate", never an error.
 */
export async function rotateSubToken(
  conn: D1Database,
  username: string,
): Promise<SubTokenOut | null> {
  const user = await db.getUser(conn, username);
  if (user === null) {
    return null;
  }
  const token = mintSubToken();
  const createdAt = nowSeconds();
  await db.setSubToken(conn, username, token, createdAt);
  return { username, sub_token: token, created_at: createdAt };
}
