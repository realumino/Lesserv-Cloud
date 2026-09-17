"""Business rules for users: uuid generation and per-node access rows.

Why this layer exists: routers do HTTP, db.py does SQL; the rules — how
uuids are minted per (user, node, exit), what an access update means —
live here. After every successful mutation this module syncs the affected
nodes so the local runtime matches the database. That sync is the
archived panel's single-node behavior; M3 removes it (step 3 of
"Life of a change" becomes empty) and the pull protocol replaces it.
"""

import time
import uuid

import db
from models import UserCreate, UserUpdate
from services import xray_service


def ensure_uuids(outbound_tags, uuids) -> dict:
    """Return a copy of `uuids` with an entry for every outbound tag.

    Why tag-keyed (the archived panel keyed by full email): uuids are
    stored per (user, node), so the username part of the email would be
    redundant storage; the render projection rebuilds the email. Existing
    tags keep their uuid — configs already shared with a user keep
    working after edits; only genuinely new pairs get a fresh uuid. Pure
    function, no database, which makes it trivial to test.
    """
    result = dict(uuids)
    for tag in outbound_tags:
        result.setdefault(tag, str(uuid.uuid4()))
    return result


async def get_user_with_access(conn, username) -> dict | None:
    """Return the UserOut-shaped dict (nested access), or None.

    Why a projection instead of a db function: the nesting is response
    shape, not storage shape; db returns flat rows and this is the single
    place the two meet.
    """
    user = await db.get_user(conn, username)
    if user is None:
        return None
    access = {}
    for row in await db.list_access_for_user(conn, username):
        access[row["node_id"]] = {
            "allowed_inbounds": row["allowed_inbounds"],
            "allowed_outbounds": row["allowed_outbounds"],
            "uuids": row["uuids"],
        }
    user["access"] = access
    return user


async def list_users_with_access(conn) -> list[dict]:
    """Return every user in the UserOut shape."""
    users = []
    for row in await db.list_users(conn):
        users.append(await get_user_with_access(conn, row["username"]))
    return users


async def _write_access(conn, username, access) -> None:
    """Upsert one access row per listed node, minting missing uuids.

    Why uuids are merged, not replaced: an existing (user, node, outbound)
    pair keeps its uuid (stability), only new outbound tags mint one —
    the archived ensure_uuids rule, applied per node.
    """
    for node_id, entry in sorted(access.items()):
        existing = await db.get_access(conn, username, node_id)
        uuids = ensure_uuids(
            entry.allowed_outbounds,
            existing["uuids"] if existing else {},
        )
        await db.upsert_access(
            conn, username, node_id,
            entry.allowed_inbounds, entry.allowed_outbounds, uuids,
        )


async def create_user(conn, data: UserCreate) -> dict:
    """Turn a UserCreate payload into a user row plus per-node access rows.

    Why the service fills uuids and created_at: they are server-generated
    facts, not client choices. After storing, the affected nodes are
    synced — the same "database changed, runtime must react" choke point
    the archived panel had. A user created with no access syncs nothing:
    a no-op mutation must not bounce Xray.
    """
    await db.create_user(conn, {
        "username": data.username,
        "status": data.status,
        "expire": data.expire,
        "note": data.note,
        "created_at": int(time.time()),
    })
    await _write_access(conn, data.username, data.access)
    if data.access:
        await xray_service.sync_nodes(conn, sorted(data.access))
    return await get_user_with_access(conn, data.username)


async def update_user(conn, username, data: UserUpdate) -> dict | None:
    """Merge a partial update; a provided access map is authoritative.

    Why authoritative membership: the admin form submits every per-node
    section at once, so the payload is the complete desired state — nodes
    left out of it lose their row. `access: None` means "leave access
    unchanged" (the archived None-means-keep rule). Returns the updated
    user, or None when the user does not exist (the router maps to 404).
    """
    existing = await db.get_user(conn, username)
    if existing is None:
        return None
    user = dict(existing)
    for field in ("status", "expire", "note"):
        value = getattr(data, field)
        if value is not None:
            user[field] = value
    await db.replace_user(conn, user)

    if data.access is not None:
        old_nodes = {
            row["node_id"] for row in await db.list_access_for_user(conn, username)
        }
        for node_id in sorted(old_nodes - set(data.access)):
            await db.delete_access(conn, username, node_id)
        await _write_access(conn, username, data.access)
        await xray_service.sync_nodes(conn, sorted(old_nodes | set(data.access)))
    return await get_user_with_access(conn, username)


async def delete_user(conn, username) -> bool:
    """Remove a user and their access rows; True when they existed.

    Why the existence check comes first: the conn interface returns rows,
    not rowcounts, so "did anything get deleted" must be observed before
    deleting; and a 404 must not bounce Xray (no sync on a no-op).
    """
    existing = await db.get_user(conn, username)
    if existing is None:
        return False
    affected = [
        row["node_id"] for row in await db.list_access_for_user(conn, username)
    ]
    await db.delete_user(conn, username)
    await xray_service.sync_nodes(conn, sorted(affected))
    return True
