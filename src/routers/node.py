"""Agent-facing endpoints: the PROTOCOL.md v1 pull contract.

Why a separate router: these are the only endpoints that authenticate by
node bearer token instead of (from M4) Cloudflare Access, and every one
is scoped to the calling node — a node must never read another node's
data. No SQL and no liveness rules live here; endpoints translate
between HTTP and the service layer.
"""

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse

import db
from models import EnrollIn, HeartbeatIn, ReportIn, StatsIn
from routers.deps import conn
from services import node_state_service, node_token_service, render_service

router = APIRouter(prefix="/api/node", tags=["node"])

PROTOCOL_VERSION = 1


def _unsupported_protocol(payload) -> None:
    """Reject a protocol version the plane cannot honor, explicitly.

    Why 400 and not 422: the body parsed fine — the plane is refusing to
    reinterpret a version it does not understand, per PROTOCOL.md. The
    agent's correct response is to keep serving its current config.
    """
    if payload.protocol != PROTOCOL_VERSION:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported protocol {payload.protocol}",
        )


async def require_node(
    request: Request,
    authorization: str = Header(default=""),
    x_lesserv_node: str = Header(default=""),
    connection=Depends(conn),
) -> dict:
    """Authenticate one node request; 401 on any mismatch, never logging.

    Why both headers are required: the node id selects the row (so errors
    and logs can name the node) and the bearer token proves it. A missing
    header, an unknown id, a node with no minted token, or a wrong token
    all look identical from the outside: 401.
    """
    scheme, _, presented = authorization.partition(" ")
    node = await db.get_node(connection, x_lesserv_node) if x_lesserv_node else None
    if (
        node is None
        or scheme.lower() != "bearer"
        or not presented
        or not node_token_service.verify_token(node["token_hash"], presented)
    ):
        raise HTTPException(status_code=401, detail="invalid node credentials")
    request.state.node_id = node["id"]
    return node


@router.post("/enroll")
async def enroll(payload: EnrollIn, node=Depends(require_node),
                 connection=Depends(conn)):
    """First contact: record versions/liveness, return metadata + hash.

    Why idempotent: re-running enroll (e.g. after editing agent.toml) is
    the correct recovery action — it records the same facts and returns
    the same shape, converging rather than duplicating anything.
    """
    _unsupported_protocol(payload)
    at = node_state_service.now()
    values = {
        "last_seen": at,
        "health": node["health"],
        "agent_version": payload.agent_version or node["agent_version"],
        "xray_version": payload.xray_version or node["xray_version"],
        "last_error": node["last_error"],
        "applied_hash": node["applied_hash"],
    }
    await node_state_service.touch_from_values(connection, node["id"], values)
    wanted, _ = await node_state_service.desired_hash(connection, node["id"])
    fresh = await db.get_node(connection, node["id"])
    return {
        "id": fresh["id"],
        "label": fresh["label"],
        "address": fresh["address"],
        "state": "active",
        "desired_hash": wanted,
    }


@router.post("/heartbeat")
async def heartbeat(payload: HeartbeatIn, node=Depends(require_node),
                    connection=Depends(conn)):
    """The 30s poll: compare hashes cheaply, write liveness rarely.

    Why the write is conditional: heartbeats are the hottest endpoint in
    the system and almost always carry no news — persisting every one
    would be hundreds of pointless writes a minute at fleet scale.
    """
    _unsupported_protocol(payload)
    at = node_state_service.now()
    wanted, _ = await node_state_service.desired_hash(connection, node["id"])
    values = node_state_service.heartbeat_values(node, payload, at)
    if node_state_service.should_touch(node, values, at):
        await node_state_service.touch_from_values(
            connection, node["id"], values)
    return {"desired_hash": wanted, "actions": []}


@router.get("/config")
async def get_config(hash: str | None = None, node=Depends(require_node),
                     connection=Depends(conn)):
    """Return this node's fully rendered runtime config, exactly as run.

    Why `?hash=` returns 409 on mismatch: the agent asks for the hash its
    heartbeat named, and if the plane moved on since, serving current
    bytes would let the agent record the wrong hash as applied — so the
    agent re-heartbeats instead. Why no-store: the body carries every
    UUID plus the REALITY private key — it must never sit in a cache.
    The agent never transforms, merges, or second-guesses it.
    """
    runtime, _ = await render_service.desired_config(connection, node["id"])
    if runtime is None:
        raise HTTPException(status_code=404, detail="no renderable config")
    wanted = render_service.config_hash(runtime)
    if hash is not None and hash != wanted:
        raise HTTPException(
            status_code=409,
            detail={"message": "desired config moved; re-heartbeat",
                    "desired_hash": wanted},
        )
    return JSONResponse(
        content={"hash": wanted, "config": runtime},
        headers={"Cache-Control": "no-store"},
    )


@router.post("/report")
async def report(payload: ReportIn, node=Depends(require_node),
                 connection=Depends(conn)):
    """Record one apply attempt; failures keep the old applied hash.

    Why a missing report is not a problem: the next heartbeat re-syncs
    reality anyway — reports are for diagnosis and the audit trail, not
    for correctness. Duplicate reports are safe by construction.
    """
    _unsupported_protocol(payload)
    values = node_state_service.report_values(
        node, payload, node_state_service.now())
    await node_state_service.touch_from_values(connection, node["id"], values)
    return {}


@router.post("/stats")
async def stats(payload: StatsIn, node=Depends(require_node)):
    """Accept absolute traffic counters; validate now, accumulate in M7.

    Why the counters are not stored: `node_stats` and the
    max(0, new-old) accumulation do not exist until M7 — but the agent
    ships absolute-plus-boot-id from v1 so history can start
    accumulating the day the plane learns to keep it.
    """
    _unsupported_protocol(payload)
    return {"accepted": len(payload.counters)}
