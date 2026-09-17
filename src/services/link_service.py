"""Generate one node's qualified share links from stored state.

Why this layer exists: links combine four node-scoped inputs — access,
authored config, REALITY keys, and profiles — and all four are stored
local. This module qualifies them consistently, builds readable labels, and
delegates URI assembly to the pure share service. It never writes, renders,
or syncs: link generation is read-only.
"""

import db
from services import (
    config_service,
    labels,
    qualify_service,
    reality_service,
    render_service,
    share_service,
)


def _base_inbound_tag(tag, node_id) -> str:
    """Remove this node's inbound suffix when present for display naming."""
    if qualify_service.is_qualified_inbound_tag(tag, node_id):
        return tag[: -(len(node_id) + 1)]
    return tag


def _base_outbound_tag(tag, node_id) -> str:
    """Remove this node's outbound prefix when present for display naming."""
    if qualify_service.is_qualified_outbound_tag(tag, node_id):
        return tag[len(node_id) + 1 :]
    return tag


def _qualified_labels(qualified_config, node_id) -> dict:
    """Map qualified tags to prettified local names for readable labels."""
    names = {}
    for inbound in qualified_config.get("inbounds", []):
        if isinstance(inbound, dict) and isinstance(inbound.get("tag"), str):
            tag = inbound["tag"]
            names[tag] = labels.pretty_tag(_base_inbound_tag(tag, node_id))
    for outbound in qualified_config.get("outbounds", []):
        if isinstance(outbound, dict) and isinstance(outbound.get("tag"), str):
            tag = outbound["tag"]
            names[tag] = labels.pretty_tag(_base_outbound_tag(tag, node_id))
    return names


def _dangling_profile_warnings(authored_config, profiles) -> list:
    """Warn for profiles attached to inbounds missing from the config."""
    try:
        known = {entry["tag"] for entry in config_service.inbound_summaries(authored_config)}
    except (AttributeError, KeyError, TypeError):
        known = set()
    warnings = []
    for profile in sorted(profiles or [], key=lambda item: item.get("id") or ""):
        inbound = profile.get("inbound_tag")
        if inbound not in known:
            warnings.append(
                f"profile '{profile.get('id')}' references unknown inbound '{inbound}'"
            )
    return warnings


async def node_links(conn, node, access_row, status, profiles) -> tuple:
    """Return qualified direct and profile links for one node and access row."""
    shaped = render_service.user_shape(
        access_row["username"], status, access_row
    )
    qualified_config = qualify_service.qualify_config(node["config_json"], node["id"])
    qualified_user = qualify_service.qualify_users([shaped], node["id"])[0]
    stored_keys = await reality_service.key_map(conn, node["id"])
    qualified_keys = qualify_service.qualify_keys(stored_keys, node["id"])
    grouped_profiles = qualify_service.qualify_profiles(profiles, node["id"])
    link_labels = _qualified_labels(qualified_config, node["id"])
    links, warnings = share_service.links_for_user(
        qualified_user,
        qualified_config,
        node["address"],
        qualified_keys,
        profiles=grouped_profiles,
        node_label=node["label"],
        labels=link_labels,
    )
    warnings.extend(_dangling_profile_warnings(node["config_json"], profiles))
    return links, warnings
