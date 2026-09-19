"""Admin endpoints for nodes: CRUD, config, runtime pane, introspection, status.

Why a separate router: nodes are the fleet's primary resource; config
parsing and the runtime pane hang off them. All paths sit under
`/api/admin/` (the route group from AGENTS.md); Cloudflare Access (M4) is
the actual authentication. No SQL and no business rules live here —
endpoints translate between HTTP and the service layer.
"""

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse

import time

import db
from models import NodeCreate, NodeOut, NodeSyncOut, NodeUpdate
from routers.deps import conn
from services import config_service, node_service, node_state_service, node_token_service, render_service

router = APIRouter(prefix="/api/admin", tags=["admin-nodes"])


async def _node_or_404(conn, node_id) -> dict:
    """Return the node row or raise 404.

    Why a helper: every node-scoped endpoint starts with the same lookup,
    and a missing node must be a 404 everywhere — one place keeps that
    honest.
    """
    node = await db.get_node(conn, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")
    return node


async def _config_or_404(conn, node_id):
    """Return the node's authored config; 404 for a missing node or config.

    Why 404 (not 503): no config yet is the expected state of a fresh
    node — the config page renders an empty state, matching the archived
    GET /api/config convention.
    """
    node = await _node_or_404(conn, node_id)
    if node["config_json"] is None:
        raise HTTPException(status_code=404, detail="config not found")
    return node["config_json"]


async def _config_or_503(conn, node_id):
    """Like _config_or_404 but 503, matching the archived tag endpoints.

    Why 503 here: "zero inbounds" and "config missing" are different
    states, and the checkbox lists must not render an empty list as if
    the admin's config had no inbounds.
    """
    node = await _node_or_404(conn, node_id)
    if node["config_json"] is None:
        raise HTTPException(
            status_code=503, detail="config not loaded for this node"
        )
    return node["config_json"]


@router.get("/nodes", response_model=list[NodeOut])
async def list_nodes(conn=Depends(conn)):
    """Return every node."""
    return await node_service.list_nodes_out(conn)


@router.post("/nodes", response_model=NodeOut, status_code=201)
async def create_node(payload: NodeCreate, conn=Depends(conn)):
    """Create a node; 409 when the id is already taken."""
    if await db.get_node(conn, payload.id) is not None:
        raise HTTPException(status_code=409, detail="node id already exists")
    return await node_service.create_node(conn, payload)


@router.get("/nodes/{node_id}", response_model=NodeOut)
async def get_node(node_id: str, conn=Depends(conn)):
    """Return one node; 404 when missing."""
    node = await node_service.get_node_out(conn, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")
    return node


@router.put("/nodes/{node_id}", response_model=NodeOut)
async def update_node(node_id: str, payload: NodeUpdate, conn=Depends(conn)):
    """Partially update a node's label/address (None stays unchanged)."""
    node = await node_service.update_node(conn, node_id, payload)
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")
    return node


@router.post("/nodes/{node_id}/token", status_code=201)
async def mint_node_token(node_id: str, conn=Depends(conn)):
    """Mint (or rotate) one node's bearer token; plaintext shown once.

    Why re-POST rotates with immediate invalidation: the new hash
    replaces the old in one statement, so there is exactly one valid
    token per node. The admin copies the plaintext into `agent.toml`
    (mode 0600) — it is never stored and never returned again.
    """
    node = await db.get_node(conn, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")
    token = node_token_service.mint_token()
    await db.set_token_hash(conn, node_id, node_token_service.token_hash(token))
    return JSONResponse(
        status_code=201,
        content={
            "node_id": node_id,
            "token": token,
            "created_at": int(time.time()),
        },
        headers={"Cache-Control": "no-store"},
    )


@router.get("/nodes/{node_id}/config")
async def get_config(node_id: str, conn=Depends(conn)):
    """Return the node's authored config, opaque and untouched."""
    return await _config_or_404(conn, node_id)


@router.put("/nodes/{node_id}/config")
async def put_config(node_id: str, payload: dict = Body(...), conn=Depends(conn)):
    """Replace the node's opaque config; agents converge on next heartbeat.

    Why PUT instead of the archived POST: replacing the whole document is
    idempotent, so a retried request can never double-apply. The body is
    a plain dict because the config is opaque — FastAPI rejects non-JSON
    bodies as 422. Pre-qualified local tags are rejected without saving.
    """
    exists, errors = await node_service.save_config(conn, node_id, payload)
    if not exists:
        raise HTTPException(status_code=404, detail="node not found")
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    return {"message": "config updated"}


@router.get("/nodes/{node_id}/config/runtime")
async def get_runtime_config(node_id: str, conn=Depends(conn)):
    """Return the config the plane would serve this node right now.

    Why a live render and not a file (M3 change): the plane no longer
    writes runtime files or runs Xray — the rendered artifact is computed
    on demand from current database state, so this pane can never go
    stale. 404 when the node has no renderable config yet.
    """
    await _node_or_404(conn, node_id)
    runtime, warnings = await render_service.desired_config(conn, node_id)
    if runtime is None:
        raise HTTPException(status_code=404, detail="runtime config not found")
    return {
        "config": runtime,
        "hash": render_service.config_hash(runtime),
        "warnings": warnings,
    }


@router.get("/nodes/{node_id}/sync", response_model=NodeSyncOut)
async def get_sync_state(node_id: str, conn=Depends(conn)):
    """Return drift at a glance: desired vs applied hash plus liveness.

    Why desired is computed live: it is a pure function of current
    database state, so the view is always fresh. `in_sync` is true only
    when a renderable config exists and the node reported that exact
    hash — the content-hash convergence property the agent loop rests
    on. 404 for an unknown node.
    """
    state = await node_state_service.sync_state(conn, node_id)
    if state is None:
        raise HTTPException(status_code=404, detail="node not found")
    return state


@router.get("/nodes/{node_id}/inbounds")
async def get_inbounds(node_id: str, conn=Depends(conn)):
    """Return every inbound's tag/protocol/network/security summaries."""
    config = await _config_or_503(conn, node_id)
    return config_service.inbound_summaries(config)


@router.get("/nodes/{node_id}/outbounds")
async def get_outbounds(node_id: str, conn=Depends(conn)):
    """Return every outbound's tag and protocol."""
    config = await _config_or_503(conn, node_id)
    return config_service.outbound_summaries(config)


@router.get("/status")
async def get_status(conn=Depends(conn)):
    """Return counts for the admin status bar.

    Why only counts: the plane no longer runs Xray (M3 deleted the local
    subprocess), so per-node health lives on the sync endpoint — this
    stays a cheap composite snapshot.
    """
    return {
        "node_count": len(await db.list_nodes(conn)),
        "user_count": len(await db.list_users(conn)),
    }
