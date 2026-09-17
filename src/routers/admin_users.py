"""Admin endpoints for users: CRUD with per-node access, and share links.

Why a separate router: users are global identity; their per-node access
is the payload's nested map, and the links endpoint aggregates across
every node the user can use. No SQL and no business rules live here.
"""

from fastapi import APIRouter, Depends, HTTPException

import db
from models import UserCreate, UserLinksOut, UserOut, UserUpdate
from routers.deps import conn
from services import reality_service, render_service, share_service, user_service

router = APIRouter(prefix="/api/admin/users", tags=["admin-users"])


async def _unknown_node_ids(conn, node_ids) -> list[str]:
    """Return the listed node ids that do not exist.

    Why the router does this and not the service: a membership payload
    referencing a missing node must fail before anything is written, and
    the router is the boundary that turns that into a 404. The service
    trusts its caller to have checked.
    """
    unknown = []
    for node_id in node_ids:
        if await db.get_node(conn, node_id) is None:
            unknown.append(node_id)
    return unknown


@router.get("", response_model=list[UserOut])
async def list_users(conn=Depends(conn)):
    """Return every user with their per-node access."""
    return await user_service.list_users_with_access(conn)


@router.post("", response_model=UserOut, status_code=201)
async def create_user(payload: UserCreate, conn=Depends(conn)):
    """Create a user; 409 when taken, 404 for an unknown node in access."""
    if await db.get_user(conn, payload.username) is not None:
        raise HTTPException(status_code=409, detail="username already exists")
    unknown = await _unknown_node_ids(conn, payload.access)
    if unknown:
        raise HTTPException(
            status_code=404, detail=f"node '{unknown[0]}' not found"
        )
    return await user_service.create_user(conn, payload)


@router.get("/{username}", response_model=UserOut)
async def get_user(username: str, conn=Depends(conn)):
    """Return one user with nested access; 404 when missing."""
    user = await user_service.get_user_with_access(conn, username)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    return user


@router.put("/{username}", response_model=UserOut)
async def update_user(username: str, payload: UserUpdate, conn=Depends(conn)):
    """Partially update a user; a provided access map replaces membership."""
    unknown = []
    if payload.access is not None:
        unknown = await _unknown_node_ids(conn, payload.access)
        if unknown:
            raise HTTPException(
                status_code=404, detail=f"node '{unknown[0]}' not found"
            )
    user = await user_service.update_user(conn, username, payload)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    return user


@router.delete("/{username}", status_code=204)
async def delete_user(username: str, conn=Depends(conn)):
    """Delete a user and their access rows; 404 when missing."""
    if not await user_service.delete_user(conn, username):
        raise HTTPException(status_code=404, detail="user not found")


async def _collect_links(conn, username, user_status, pairs) -> tuple[list, list]:
    """Build every link across the user's config-bearing nodes.

    Why the node id rides on each link: a subscription (M6) joins links
    from several nodes, and each link must carry its own node's address
    and key derivation. Warnings are prefixed with the node id so a
    multi-node list stays readable.
    """
    links, warnings = [], []
    for row, node in pairs:
        shaped = render_service.user_shape(row["username"], user_status, row)
        keys = await reality_service.key_map(conn, node["id"])
        node_links, node_warnings = share_service.links_for_user(
            shaped, node["config_json"], node["address"], keys,
        )
        for link in node_links:
            link["node"] = node["id"]
        links.extend(node_links)
        warnings.extend(f"{node['id']}: {w}" for w in node_warnings)
    return links, warnings


@router.get("/{username}/links", response_model=UserLinksOut)
async def get_user_links(username: str, conn=Depends(conn)):
    """Return every share link the user is entitled to, across nodes.

    Why read-only: links are a view over existing config and access rows;
    generating them must not restart Xray or touch the database. The
    archived status codes carry over: 404 unknown user, 503 when the user
    has access but no node config to build from, 409 when no node has a
    usable address. Nodes without a config are skipped with a warning.
    """
    user = await db.get_user(conn, username)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    pairs = [
        (row, await db.get_node(conn, row["node_id"]))
        for row in await db.list_access_for_user(conn, username)
    ]
    with_config = [
        (row, node) for row, node in pairs
        if node is not None and node["config_json"] is not None
    ]
    if pairs and not with_config:
        raise HTTPException(
            status_code=503, detail="no node config to build links from"
        )
    warnings = [
        f"{node['id']}: has no config; skipped"
        for row, node in pairs if node is None or node["config_json"] is None
    ]
    addressable = [
        (row, node) for row, node in with_config
        if share_service.has_usable_address(node["config_json"], node["address"])
    ]
    if with_config and not addressable:
        raise HTTPException(status_code=409, detail="no node has a usable address")
    links, more = await _collect_links(conn, username, user["status"], addressable)
    warnings.extend(more)
    warnings.extend(
        f"{node['id']}: has no usable address"
        for row, node in with_config if (row, node) not in addressable
    )
    return {"username": username, "links": links, "warnings": warnings}
