"""Rules for node liveness, apply reports, and drift display.

Why this layer exists: heartbeats must be cheap (no write on every poll),
reports must translate stage+ok into stored health without touching the
applied hash on failure, and the admin sync view must combine a live
render with stored facts. Routers do HTTP; db.py does SQL; the decisions
live here. Pure helpers stay synchronous so they unit-test without a db.
"""

import time

import db
from services import render_service

HEARTBEAT_STALE_AFTER = 60
SUCCESS_STAGES = ("applied", "started")


def now() -> int:
    """Return Unix seconds from the plane's clock (the time authority)."""
    return int(time.time())


def heartbeat_values(node, payload, at) -> dict:
    """Compute the liveness columns one heartbeat wants stored.

    Why applied_hash is adopted but versions/health/last_error are
    preserved: the dashboard shows "as last reported", and the heartbeat
    is the freshest claim of what runs — but versions arrive on enroll
    (the heartbeat carries none) and health is a diagnosis that only a
    report may set or clear.
    """
    values = {
        "last_seen": at,
        "health": node["health"],
        "agent_version": node["agent_version"],
        "xray_version": node["xray_version"],
        "last_error": node["last_error"],
        "applied_hash": payload.applied_hash,
    }
    return values


def should_touch(node, values, at) -> bool:
    """Return True when a heartbeat's values deserve a database write.

    Why the 60s staleness rule: at fleet scale an unconditional write per
    30s poll is hundreds of writes a minute for no information gain. A
    write happens only when liveness went stale or a fact actually
    changed — heartbeats stay cheap.
    """
    if node["last_seen"] is None:
        return True
    if at - node["last_seen"] > HEARTBEAT_STALE_AFTER:
        return True
    for key in ("health", "agent_version", "xray_version",
                "last_error", "applied_hash"):
        if values[key] != node[key]:
            return True
    return False


def report_values(node, payload, at) -> dict:
    """Compute the liveness columns one apply report wants stored.

    Why a failed apply never moves applied_hash: the node rolled back to
    last-good, so what runs is still the old hash — recording the failed
    one would hide the drift the dashboard must show. Success on
    `applied`/`started` adopts the hash and clears the error; success on
    earlier stages only clears nothing and moves nothing.
    """
    values = {
        "last_seen": at,
        "health": node["health"],
        "agent_version": node["agent_version"],
        "xray_version": node["xray_version"],
        "last_error": node["last_error"],
        "applied_hash": node["applied_hash"],
    }
    if payload.ok and payload.stage in SUCCESS_STAGES:
        values["applied_hash"] = payload.hash
        values["last_error"] = None
        values["health"] = "ok"
    elif not payload.ok:
        values["last_error"] = payload.error
        values["health"] = f"error:{payload.stage}"
    return values


async def touch_from_values(conn, node_id, values) -> None:
    """Write precomputed liveness values through the single db statement."""
    await db.touch_node(
        conn, node_id, values["last_seen"], values["health"],
        values["agent_version"], values["xray_version"],
        values["last_error"], values["applied_hash"],
    )


async def desired_hash(conn, node_id) -> tuple[str | None, list[str]]:
    """Return (hex hash | None, warnings) of one node's desired config.

    Why None instead of raising: no config and malformed config are
    states the agent must ride out calmly — the heartbeat carries null
    and the agent changes nothing.
    """
    runtime, warnings = await render_service.desired_config(conn, node_id)
    if runtime is None:
        return None, warnings
    return render_service.config_hash(runtime), warnings


async def sync_state(conn, node_id) -> dict | None:
    """Return the NodeSyncOut-shaped drift view for one node, or None.

    Why the render happens here: drift is desired-vs-applied, and desired
    is a pure function of current database state — computing it live
    means the view can never go stale the way a stored column would.
    """
    node = await db.get_node(conn, node_id)
    if node is None:
        return None
    wanted, warnings = await desired_hash(conn, node_id)
    return {
        "node_id": node_id,
        "state": "active" if node["last_seen"] is not None else "pending",
        "desired_hash": wanted,
        "applied_hash": node["applied_hash"],
        "in_sync": wanted is not None and node["applied_hash"] == wanted,
        "last_seen": node["last_seen"],
        "health": node["health"],
        "agent_version": node["agent_version"],
        "xray_version": node["xray_version"],
        "last_error": node["last_error"],
        "warnings": warnings,
    }
