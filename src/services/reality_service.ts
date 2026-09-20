/**
 * Generate, store, and rotate one node's REALITY X25519 keys.
 *
 * WHY this exists: the plane owns `realitySettings.privateKey` — every
 * render overwrites it with a key generated here and stored per
 * (node_id, inbound_tag), regardless of what the authored config says. The
 * database is the source of truth, so share links can derive the right
 * public key (`pbk`) even when the stored config still carries the admin's
 * own placeholder key.
 *
 * Keys are stable across renders: generated once per (node, tag), replaced
 * only by explicit rotation (which breaks every client using the old key —
 * hence it must be a deliberate operator action, never an automatic side
 * effect of a render).
 *
 * Keys are always stored via `key_cipher` as `v1:` AES-GCM ciphertext under
 * the Worker secret; there is no plaintext mode. Decryption has exactly one
 * seam (`keyMap`/`unseal`), so the render and link paths always see the
 * usable key while storage never does.
 */

import { derivePublicKey, generatePrivateKey } from "../core/x25519";
import * as db from "../db";
import { realityInboundTags } from "./config_service";
import { seal, unseal } from "./key_cipher";

/** WHAT: a JSON object carrying authored or rendered config data. */
type Dict = Record<string, unknown>;

/** WHAT: one reality endpoint row: config-ordered, public parts only. */
export type RealityKeyOut = {
  inbound: string;
  public_key: string | null;
  created_at: number | null;
};

/** WHAT: Unix seconds from the plane's clock (the time authority). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * WHAT: return {inbound_tag: private_key} for one node's stored keys, decrypted.
 *
 * WHY the flat shape: `applyRealityKeys` fills the runtime by looking up
 * each inbound's tag, and share links pick their private key per inbound
 * the same way — a plain dict keeps both callers trivial. WHY unseal here:
 * storage holds `v1:` ciphertext, and every consumer of this module needs
 * the usable key, so decryption has exactly one seam.
 */
export async function keyMap(
  env: Env,
  nodeId: string,
): Promise<Record<string, string>> {
  const stored = await db.listRealityKeys(env.DB, nodeId);
  const keys: Record<string, string> = {};
  for (const [tag, row] of Object.entries(stored)) {
    keys[tag] = await unseal(env, row.private_key);
  }
  return keys;
}

/**
 * WHAT: generate and store a key for every REALITY inbound missing one.
 *
 * WHY called from the render path: a config can arrive at any time and
 * every render runs through the same choke point, so a newly added
 * REALITY inbound gets a stored key without any extra wiring. Idempotent:
 * only the missing tags generate. Seal happens here and nowhere else — a
 * plaintext key must never reach storage. Returns the full decrypted
 * {tag: private_key} map.
 */
export async function ensureKeys(
  env: Env,
  nodeId: string,
  config: Dict,
): Promise<Record<string, string>> {
  const stored = await keyMap(env, nodeId);
  for (const tag of realityInboundTags(config)) {
    if (!(tag in stored)) {
      const sealed = await seal(env, generatePrivateKey());
      await db.upsertRealityKey(env.DB, nodeId, tag, sealed, nowSeconds());
    }
  }
  return await keyMap(env, nodeId);
}

/**
 * WHAT: replace one stored key; return the new private key.
 *
 * WHY the timestamp is refreshed: `created_at` doubles as the
 * generation/rotation time, so the UI can show when the current key
 * became effective. Callers must re-render afterwards — until then the
 * runtime still serves the old key. Returns the plaintext key because the
 * rotation response derives its public half from it.
 */
export async function rotateKey(
  env: Env,
  nodeId: string,
  tag: string,
): Promise<string> {
  const privateKey = generatePrivateKey();
  const sealed = await seal(env, privateKey);
  await db.upsertRealityKey(env.DB, nodeId, tag, sealed, nowSeconds());
  return privateKey;
}

/**
 * WHAT: return the derived public key of one stored key, or null when absent.
 *
 * WHY derive and not store: the public key is a pure function of the
 * private key, so storing it would only invite the two disagreeing. None
 * means the tag has no key yet — the caller renders an empty state.
 */
export async function publicKey(
  env: Env,
  nodeId: string,
  tag: string,
): Promise<string | null> {
  const privateKey = (await keyMap(env, nodeId))[tag];
  if (privateKey === undefined) {
    return null;
  }
  return derivePublicKey(privateKey);
}

/**
 * WHAT: rows for the reality endpoint: config-ordered, public parts only.
 *
 * WHY ordered by the config: the admin reads the panel in the shape of
 * their own config, and a stable order keeps the UI from jumping between
 * renders. Tags without a stored key appear with null public_key /
 * created_at instead of being hidden — the admin must see that a key is
 * pending. The private key is never returned; only its derived public
 * half leaves the process.
 */
export async function listKeys(
  env: Env,
  nodeId: string,
  config: Dict,
): Promise<RealityKeyOut[]> {
  const stored = await db.listRealityKeys(env.DB, nodeId);
  const rows: RealityKeyOut[] = [];
  for (const tag of realityInboundTags(config)) {
    const row = stored[tag];
    let derived: string | null = null;
    if (row !== undefined) {
      const privateKey = await unseal(env, row.private_key);
      derived = derivePublicKey(privateKey);
    }
    rows.push({
      inbound: tag,
      public_key: derived,
      created_at: row ? row.created_at : null,
    });
  }
  return rows;
}
