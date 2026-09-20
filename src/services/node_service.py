"""Business rules for nodes: creation facts and config storage.

Why this layer exists: nodes are the new dimension of the fleet model.
Their rules are thin (the server stamps created_at, the config blob is
opaque) but they belong here, not in the router — same split as the
archived panel: routers do HTTP, services hold rules, db holds SQL.
Nothing is pushed after a write; agents converge on next heartbeat (M3).
"""

import time

import db
from models import NodeCreate, NodeUpdate
from services import qualify_service

_REPORTED_MAX_LEN = 255


def reported_address_for(detected_ip, connecting_ip) -> str | None:
    """Pick the reported address to store: the agent's claim, else the edge.

    Why the agent's detected_ip wins: PROTOCOL.md defines it as the
    node's own best guess at its public address. CF-Connecting-IP is the
    fallback for agents that send none — the same fact, observed by the
    edge instead of reported. The result is display data only, so an
    oversized or whitespace-riddled value is skipped rather than
    sanitized into something that looks trustworthy.
    """
    for candidate in (detected_ip, connecting_ip):
        if not candidate:
            continue
        value = candidate.strip()
        if (
            value
            and len(value) <= _REPORTED_MAX_LEN
            and not any(char.isspace() for char in value)
        ):
            return value
    return None


def _to_out(node: dict) -> dict:
    """Project a db node row to the NodeOut shape.

    Why has_config: a list view must learn which nodes have a config
    without fetching every config blob.
    """
    return {
        "id": node["id"],
        "label": node["label"],
        "address": node["address"],
        "reported_address": node["reported_address"],
        "created_at": node["created_at"],
        "has_config": node["config_json"] is not None,
    }


async def create_node(conn, data: NodeCreate) -> dict:
    """Create a node row; no config and no token yet.

    Why no token: the bearer token is minted separately (POST
    .../token) so creation and credential issuance stay distinct
    operator actions — the plaintext is shown once at mint time.
    """
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


async def save_config(conn, node_id, payload) -> tuple[bool, list[str]]:
    """Replace a node's opaque config, when its tags are valid.

    Why the dict is stored untouched: the config is opaque — the plane
    never validates or interprets its structure, except for tag-name
    validation at paste time. The tuple separates a missing node from an
    invalid payload: `(False, [])` means 404, `(True, errors)` means 422,
    and `(True, [])` means the config was saved. Nothing is pushed: each
    node's agent picks the new render up on its next heartbeat (M3).
    """
    node = await db.get_node(conn, node_id)
    if node is None:
        return False, []
    errors = qualify_service.local_tag_errors(payload, node_id)
    if errors:
        return True, errors
    await db.set_node_config(conn, node_id, payload)
    return True, []
