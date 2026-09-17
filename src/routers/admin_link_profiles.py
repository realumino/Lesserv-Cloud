"""Admin endpoints for per-inbound link profiles.

Why a separate router: profiles are a fourth admin-managed resource with
their own identity and validation. They describe extra client views of an
inbound and never change the rendered runtime config. No SQL and no profile
rules live here.
"""

from fastapi import APIRouter, Depends, HTTPException

import db
from models import LinkProfileIn, LinkProfileOut, LinkProfileUpdate
from routers.deps import conn
from services import link_profile_service

router = APIRouter(
    prefix="/api/admin/nodes/{node_id}/link-profiles",
    tags=["admin-link-profiles"],
)


async def _node_or_404(conn, node_id) -> dict:
    """Return the node row or raise 404.

    Why a helper: every profile endpoint starts with the same lookup, and a
    missing node must be a 404 everywhere.
    """
    node = await db.get_node(conn, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")
    return node


@router.get("", response_model=list[LinkProfileOut])
async def list_profiles(node_id: str, conn=Depends(conn)):
    """Return one node's link profiles in display order."""
    await _node_or_404(conn, node_id)
    return await link_profile_service.list_profiles(conn, node_id)


@router.post("", response_model=LinkProfileOut, status_code=201)
async def create_profile(node_id: str, payload: LinkProfileIn, conn=Depends(conn)):
    """Create a profile attached to one of the node's authored inbounds."""
    node = await _node_or_404(conn, node_id)
    errors = link_profile_service.validate_create(node, payload)
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    if await link_profile_service.get_profile(conn, node_id, payload.id) is not None:
        raise HTTPException(status_code=409, detail="profile id already exists")
    return await link_profile_service.create_profile(conn, node_id, payload)


@router.get("/{profile_id}", response_model=LinkProfileOut)
async def get_profile(node_id: str, profile_id: str, conn=Depends(conn)):
    """Return one profile; 404 when the node or profile is missing."""
    await _node_or_404(conn, node_id)
    profile = await link_profile_service.get_profile(conn, node_id, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return profile


@router.put("/{profile_id}", response_model=LinkProfileOut)
async def update_profile(
    node_id: str, profile_id: str, payload: LinkProfileUpdate, conn=Depends(conn)
):
    """Partially update a profile; a missing profile is a 404."""
    node = await _node_or_404(conn, node_id)
    errors = link_profile_service.validate_update(node, payload)
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    profile = await link_profile_service.update_profile(
        conn, node_id, profile_id, payload
    )
    if profile is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return profile


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(node_id: str, profile_id: str, conn=Depends(conn)):
    """Delete a profile; a missing profile is a 404."""
    await _node_or_404(conn, node_id)
    if not await link_profile_service.delete_profile(conn, node_id, profile_id):
        raise HTTPException(status_code=404, detail="profile not found")
