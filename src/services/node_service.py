"""Business rules for nodes: creation facts, config storage, sync triggers.

Why this layer exists: nodes are the new dimension of the fleet model.
Their rules are thin (the server stamps created_at, the config blob is
opaque) but they belong here, not in the router — same split as the
archived panel: routers do HTTP, services hold rules, db holds SQL.
"""

import time

import db
from models import NodeCreate, NodeUpdate
from services import xray_service


def _to_out(node: dict) -> dict:
    """Project a db node row to the NodeOut shape.

    Why has_config: a list view must learn which nodes have a config
    without fetching every config blob.
    """
    return {
        "id": node["id"],
        "label": node["label"],
        "address": node["address"],
        "created_at": node["created_at"],
        "has_config": node["config_json"] is not None,
    }


async def create_node(conn, data: NodeCreate) -> dict:
    """Create a node row; no config and no token yet (M3 mints tokens)."""
    await db.create_node(conn, {
        "id": data.id,
        "label": data.label,
        "address": data.address,
        "created_at": int(time.time()),
    })
    return _to_out(await db.get_node(conn, data.id))


async def update_node(conn, node_id, data: NodeUpdate) -> dict | None:
    """Merge a partial update (None = unchanged); None when missing.

    Why no sync here: label and address never change a rendered config —
    the address only feeds share links, which are derived at request
    time. Renaming a label can never break a client.
    """
    node = await db.get_node(conn, node_id)
    if node is None:
        return None
    if data.label is not None:
        node["label"] = data.label
    if data.address is not None:
        node["address"] = data.address
    await db.replace_node(conn, node)
    return _to_out(await db.get_node(conn, node_id))


async def get_node_out(conn, node_id) -> dict | None:
    """NodeOut-shaped dict, or None when missing."""
    node = await db.get_node(conn, node_id)
    return _to_out(node) if node else None


async def list_nodes_out(conn) -> list[dict]:
    """Every node in the NodeOut shape, id-ordered."""
    return [_to_out(node) for node in await db.list_nodes(conn)]


async def save_config(conn, node_id, payload) -> bool:
    """Replace a node's opaque config and sync it; False when missing.

    Why the dict is stored untouched: the config is opaque — the plane
    never validates or interprets its structure (M2 adds tag-name
    validation at paste time only). The sync here is the archived POST
    /api/config behavior: the database changed, the local runtime must
    react.
    """
    node = await db.get_node(conn, node_id)
    if node is None:
        return False
    await db.set_node_config(conn, node_id, payload)
    await xray_service.sync_node(conn, node_id)
    return True
