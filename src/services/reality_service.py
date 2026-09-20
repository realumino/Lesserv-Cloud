"""Generate, store, and rotate one node's REALITY X25519 keys.

Why this exists: the plane owns `realitySettings.privateKey` — every render
overwrites it with a key generated here and stored per (node_id,
inbound_tag), regardless of what the authored config says. The database is
the source of truth, so share links can derive the right public key (`pbk`)
even when the stored config still carries the admin's own placeholder key.

Keys are stable across renders: generated once per (node, tag), replaced
only by explicit rotation (which breaks every client using the old key —
hence it must be a deliberate operator action, never an automatic side
effect of a render).

Keys are always stored via `key_cipher` as `v1:` AES-GCM ciphertext under
the Worker secret; there is no plaintext mode. Decryption has exactly one
seam (`key_map`/`unseal`), so the render and link paths always see the
usable key while storage never does.
"""

import time

from core import x25519
from db import list_reality_keys, upsert_reality_key
from services import config_service, key_cipher


async def key_map(conn, node_id) -> dict:
    """Return {inbound_tag: private_key} for one node's stored keys, decrypted.

    Why the flat shape: apply_reality_keys fills the runtime by looking up
    each inbound's tag, and share links pick their private key per inbound
    the same way — a plain dict keeps both callers trivial. Why unseal
    here: storage holds `v1:` ciphertext under M4, and every consumer of
    this module needs the usable key, so decryption has exactly one seam.
    """
    stored = await list_reality_keys(conn, node_id)
    return {tag: await key_cipher.unseal(row["private_key"])
            for tag, row in stored.items()}


async def ensure_keys(conn, node_id, config) -> dict:
    """Generate and store a key for every REALITY inbound missing one.

    Why called from the render path: a config can arrive at any time and
    every render runs through the same choke point, so a newly added
    REALITY inbound gets a stored key without any extra wiring. Idempotent:
    only the missing tags generate. Seal happens here and nowhere else —
    a plaintext key must never reach storage when a cipher is available.
    Returns the full decrypted {tag: private_key} map.
    """
    stored = await key_map(conn, node_id)
    for tag in config_service.reality_inbound_tags(config):
        if tag not in stored:
            sealed = await key_cipher.seal(x25519.generate_private_key())
            await upsert_reality_key(
                conn, node_id, tag, sealed, int(time.time()),
            )
    return await key_map(conn, node_id)


async def rotate_key(conn, node_id, tag) -> str:
    """Replace one stored key; return the new private key.

    Why the timestamp is refreshed: `created_at` doubles as the
    generation/rotation time, so the UI can show when the current key
    became effective. Callers must re-render afterwards — until then the
    runtime still serves the old key. Returns the plaintext key because
    the rotation response derives its public half from it.
    """
    private_key = x25519.generate_private_key()
    sealed = await key_cipher.seal(private_key)
    await upsert_reality_key(conn, node_id, tag, sealed, int(time.time()))
    return private_key


async def public_key(conn, node_id, tag) -> str | None:
    """Return the derived public key of one stored key, or None when absent.

    Why derive and not store: the public key is a pure function of the
    private key, so storing it would only invite the two disagreeing.
    None means the tag has no key yet — the caller renders an empty state.
    """
    private_key = (await key_map(conn, node_id)).get(tag)
    if private_key is None:
        return None
    return x25519.derive_public_key(private_key)


async def list_keys(conn, node_id, config) -> list[dict]:
    """Rows for the reality endpoint: config-ordered, public parts only.

    Why ordered by the config: the admin reads the panel in the shape of
    their own config, and a stable order keeps the UI from jumping between
    renders. Tags without a stored key appear with null public_key /
    created_at instead of being hidden — the admin must see that a key is
    pending. The private key is never returned; only its derived public
    half leaves the process.
    """
    stored = await list_reality_keys(conn, node_id)
    rows = []
    for tag in config_service.reality_inbound_tags(config):
        row = stored.get(tag)
        public_key = None
        if row is not None:
            private_key = await key_cipher.unseal(row["private_key"])
            public_key = x25519.derive_public_key(private_key)
        rows.append({
            "inbound": tag,
            "public_key": public_key,
            "created_at": row["created_at"] if row else None,
        })
    return rows
