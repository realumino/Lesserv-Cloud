"""Admin endpoints for one node's REALITY keys: list and rotate.

Why a separate router: REALITY keys are the third resource (after nodes
and users). No SQL and no key logic live here — endpoints translate
between HTTP and the service layer, and never touch a private key: the
API returns only derived public keys.
"""

from fastapi import APIRouter, Depends, HTTPException

import db
from routers.deps import conn
from services import config_service, reality_service

router = APIRouter(prefix="/api/admin", tags=["admin-reality"])


async def _reality_config_or_404(conn, node_id):
    """Return the node's authored config; 404 for a missing node or config.

    Why 404 (not 503): mirroring the archived reality router — a node
    without a config has no REALITY inbounds to list, which is the same
    "nothing here yet" state the config page renders as empty.
    """
    node = await db.get_node(conn, node_id)
    if node is None or node["config_json"] is None:
        raise HTTPException(status_code=404, detail="config not found")
    return node["config_json"]


@router.get("/nodes/{node_id}/reality")
async def get_reality_keys(node_id: str, conn=Depends(conn)):
    """List every REALITY inbound with its derived public key.

    Why the private key is not returned: clients only ever need `pbk`;
    the private key is visible where it is actually used (the runtime
    config pane) and nowhere else.
    """
    config = await _reality_config_or_404(conn, node_id)
    return {"keys": await reality_service.list_keys(conn, node_id, config)}


@router.post("/nodes/{node_id}/reality/rotate")
async def rotate_all_keys(node_id: str, conn=Depends(conn)):
    """Rotate the key of every REALITY inbound.

    Why one call for all: replacing the whole key set is the operator's
    "start over" action. Nodes pick the new keys up on their next
    heartbeat — rotation never pushes.
    """
    config = await _reality_config_or_404(conn, node_id)
    tags = config_service.reality_inbound_tags(config)
    if not tags:
        raise HTTPException(
            status_code=404, detail="no REALITY inbounds in config"
        )
    for tag in tags:
        await reality_service.rotate_key(conn, node_id, tag)
    return {"rotated": tags}


@router.post("/nodes/{node_id}/reality/{tag}/rotate")
async def rotate_key(node_id: str, tag: str, conn=Depends(conn)):
    """Rotate one REALITY inbound's key.

    Why 404 for a non-REALITY tag: rotating a key that Xray never reads
    would silently do nothing — the operator must learn the tag does not
    exist instead of seeing success.
    """
    config = await _reality_config_or_404(conn, node_id)
    if tag not in config_service.reality_inbound_tags(config):
        raise HTTPException(
            status_code=404, detail=f"no REALITY inbound tagged '{tag}'"
        )
    await reality_service.rotate_key(conn, node_id, tag)
    return {
        "inbound": tag,
        "public_key": await reality_service.public_key(conn, node_id, tag),
    }
