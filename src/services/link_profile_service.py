"""Business rules for per-inbound link profiles.

Why this layer exists: profiles are stored link variants, not config. Their
rules — attachment to a real authored inbound and a node-scoped identity —
belong here. Profile writes never sync nodes because profiles never enter
the rendered runtime config.
"""

import time

import db
from models import LinkProfileIn, LinkProfileUpdate
from services import config_service


def _to_out(profile: dict) -> dict:
    """Project a database profile to the LinkProfileOut shape."""
    return {
        "id": profile["id"],
        "inbound_tag": profile["inbound_tag"],
        "label": profile["label"],
        "overrides": profile["overrides"],
        "created_at": profile["created_at"],
    }


def _authored_inbound_tags(config) -> set:
    """Return inbound tags from an authored config, tolerating bad shapes."""
    try:
        return {entry["tag"] for entry in config_service.inbound_summaries(config)}
    except (AttributeError, KeyError, TypeError):
        return set()


def validate_create(node: dict, data: LinkProfileIn) -> list:
    """Return semantic errors for a new profile, without touching storage."""
    if node.get("config_json") is None:
        return ["node has no config to attach a profile to"]
    if data.inbound_tag not in _authored_inbound_tags(node["config_json"]):
        return [f"unknown inbound '{data.inbound_tag}'"]
    return []


def validate_update(node: dict, data: LinkProfileUpdate) -> list:
    """Return semantic errors for a profile update, without touching storage."""
    if data.inbound_tag is None:
        return []
    if node.get("config_json") is None:
        return ["node has no config to attach a profile to"]
    if data.inbound_tag not in _authored_inbound_tags(node["config_json"]):
        return [f"unknown inbound '{data.inbound_tag}'"]
    return []


async def list_profiles(conn, node_id) -> list:
    """Return one node's profiles in deterministic display order."""
    return [_to_out(profile) for profile in await db.list_link_profiles(conn, node_id)]


async def get_profile(conn, node_id, profile_id) -> dict | None:
    """Return one profile in API shape, or None when missing."""
    profile = await db.get_link_profile(conn, node_id, profile_id)
    return _to_out(profile) if profile else None


async def create_profile(conn, node_id, data: LinkProfileIn) -> dict:
    """Store one validated profile and stamp its creation time."""
    profile = {
        "node_id": node_id,
        "id": data.id,
        "inbound_tag": data.inbound_tag,
        "label": data.label,
        "overrides": dict(data.overrides),
        "created_at": int(time.time()),
    }
    await db.create_link_profile(conn, profile)
    return _to_out(profile)


async def update_profile(conn, node_id, profile_id, data: LinkProfileUpdate) -> dict | None:
    """Merge a partial profile update; return None when the profile is missing."""
    stored = await db.get_link_profile(conn, node_id, profile_id)
    if stored is None:
        return None
    if data.inbound_tag is not None:
        stored["inbound_tag"] = data.inbound_tag
    if data.label is not None:
        stored["label"] = data.label
    if data.overrides is not None:
        stored["overrides"] = dict(data.overrides)
    await db.update_link_profile(conn, stored)
    return _to_out(await db.get_link_profile(conn, node_id, profile_id))


async def delete_profile(conn, node_id, profile_id) -> bool:
    """Remove one profile; False when it did not exist."""
    if await db.get_link_profile(conn, node_id, profile_id) is None:
        return False
    await db.delete_link_profile(conn, node_id, profile_id)
    return True
