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

M1 note: keys are stored as plaintext. M4 adds the Worker secret and the
`v1:<base64(iv || ct+tag)>` ciphertext format; crypto.py (WebCrypto) only
exists inside workerd, so the local CPython runtime cannot encrypt yet.
"""

import time

from core import x25519
from db import list_reality_keys, upsert_reality_key
from services import config_service


async def key_map(conn, node_id) -> dict:
    """Return {inbound_tag: private_key} for one node's stored keys.

    Why the flat shape: apply_reality_keys fills the runtime by looking up
    each inbound's tag, and share links pick their private key per inbound
    the same way — a plain dict keeps both callers trivial.
    """
    stored = await list_reality_keys(conn, node_id)
    return {tag: row["private_key"] for tag, row in stored.items()}


async def ensure_keys(conn, node_id, config) -> dict:
    """Generate and store a key for every REALITY inbound missing one.

    Why called from the render path: a config can arrive at any time and
    every render runs through the same choke point, so a newly added
    REALITY inbound gets a stored key without any extra wiring. Idempotent:
    only the missing tags generate. Returns the full {tag: private_key} map.
    """
    stored = await key_map(conn, node_id)
    for tag in config_service.reality_inbound_tags(config):
        if tag not in stored:
            await upsert_reality_key(
                conn, node_id, tag,
                x25519.generate_private_key(), int(time.time()),
            )
    return await key_map(conn, node_id)


async def rotate_key(conn, node_id, tag) -> str:
    """Replace one stored key; return the new private key.

    Why the timestamp is refreshed: `created_at` doubles as the
    generation/rotation time, so the UI can show when the current key
    became effective. Callers must re-render afterwards — until then the
    runtime still serves the old key.
    """
    private_key = x25519.generate_private_key()
    await upsert_reality_key(conn, node_id, tag, private_key, int(time.time()))
    return private_key


async def public_key(conn, node_id, tag) -> str | None:
    """Return the derived public key of one stored key, or None when absent.

    Why derive and not store: the public key is a pure function of the
    private key, so storing it would only invite the two disagreeing.
    None means the tag has no key yet — the caller renders an empty state.
    """
    stored = await list_reality_keys(conn, node_id)
    row = stored.get(tag)
    if row is None:
        return None
    return x25519.derive_public_key(row["private_key"])


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
        rows.append({
            "inbound": tag,
            "public_key": (
                x25519.derive_public_key(row["private_key"]) if row else None
            ),
            "created_at": row["created_at"] if row else None,
        })
    return rows
