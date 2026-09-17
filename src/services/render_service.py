"""Render one node's desired runtime config from stored state.

Why this exists: the pipeline "node + access rows + keys → runtime config"
must be a deterministic, per-node function of the database state, so the
plane can compute a node's desired hash with no side effects beyond reads
and key generation. The archived panel's pure core (config_service) is
reused untouched; this module only prepares its inputs.

This module is the single seam where the qualifier plugs in: the projection
below rebuilds the archived user shape with local tags, and qualification
rewrites those shapes (and the config's tags) between projection and
`build_config`. If `build_config` or `apply_reality_keys` ever need
editing to make multi-node work, the qualifier is doing its job wrong.
"""

import hashlib
import json

from db import get_node, list_access_for_node, list_users
from services import config_service, qualify_service, reality_service


def user_shape(username, status, access_row) -> dict:
    """Project one access row into the archived user dict the pure core expects.

    Why the email is rebuilt here: storage keys uuids by local outbound
    tag (per the locked data model); build_config and the allocator look
    clients up by client email (`username@outboundtag`). `qualify_users`
    rewrites exactly this line — the stored key and the pure core never
    change.
    """
    return {
        "username": username,
        "status": status,
        "allowed_inbounds": access_row["allowed_inbounds"],
        "allowed_outbounds": access_row["allowed_outbounds"],
        "uuids": {
            f"{username}@{tag}": uuid
            for tag, uuid in access_row["uuids"].items()
        },
    }


async def node_users(conn, node_id) -> list[dict]:
    """Return one node's access rows in the archived user shape.

    Why disabled users pass through: config_service.user_permissions
    filters them out — it is the copied pure core's policy, and keeping
    this function a dumb shape-shifter avoids a second place that decides
    who is rendered. Sorted by username (db does it) for deterministic
    renders: the same database state must hash identically every time.
    """
    rows = await list_access_for_node(conn, node_id)
    users = {u["username"]: u for u in await list_users(conn)}
    projected = []
    for row in rows:
        user = users.get(row["username"])
        if user is None:
            continue
        projected.append(user_shape(row["username"], user["status"], row))
    return projected


async def desired_config(conn, node_id) -> tuple[dict | None, list[str]]:
    """Return (runtime_config | None, warnings) for one node.

    Why (None, ...) instead of raising: "no config yet" and "config too
    malformed to render" are states the caller must handle calmly — the
    archived sync warned and skipped, and a user edit must never turn
    into a 500. The catch is wider than the archived sync's because key
    generation now sits inside the same block, and `reality_inbound_tags`
    probes the config's structure before build_config ever runs. Key
    generation happens here so every path that renders also guarantees a
    stored key per REALITY inbound (one choke point).
    """
    node = await get_node(conn, node_id)
    if node is None or node["config_json"] is None:
        return None, []
    config = node["config_json"]
    users = await node_users(conn, node_id)
    try:
        keys = await reality_service.ensure_keys(conn, node_id, config)
        qualified_config = qualify_service.qualify_config(config, node_id)
        qualified_users = qualify_service.qualify_users(users, node_id)
        qualified_keys = qualify_service.qualify_keys(keys, node_id)
        runtime, warnings = config_service.build_config(qualified_config, qualified_users)
        warnings = warnings + config_service.apply_reality_keys(runtime, qualified_keys)
    except (KeyError, TypeError, AttributeError) as error:
        return None, [f"config looks malformed ({error}); skipping render"]
    return runtime, warnings


def config_hash(runtime) -> str:
    """Return the content hash of one rendered config.

    Why canonical JSON (sorted keys, no whitespace): the hash must depend
    on the configuration, never on dict ordering or formatting, so equal
    states always produce equal hashes — the property the agent's
    applied_hash comparison (M3) rests on.
    """
    canonical = json.dumps(runtime, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()
