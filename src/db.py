"""All database access lives behind this module.

D1 is the only backend, and this file is the only place it is spoken to.
Every function here speaks one tiny protocol —
`await conn.execute(sql, params) -> list[dict]` — and callers never see
the D1 binding itself.

Why async everywhere: D1 has no synchronous API, so db functions must be
`async def` in production. The asymmetry is the convention, not an
accident: pure code (core/, services' pure helpers) stays synchronous;
anything that touches a conn is `async def`.

Why this is the only file containing SQL: the data model lives in
`migrations/*.sql`, but every query that reads or writes it lives here,
so schema and access patterns are findable in exactly two places.

There is no second backend and no fallback: the app runs under workerd,
and outside a Worker there is no database — `get_conn` raises rather
than pretend. (tests/workerd runs the real plane; tests/pure only ever
touches pure modules that never see a conn.)
"""

import json

_ACCESS_JSON_COLS = ("allowed_inbounds", "allowed_outbounds", "uuids")
_PROFILE_JSON_COLS = ("overrides",)


class D1Conn:
    """Async facade over a D1 binding (`env.DB`).

    Why a wrapper at all: D1 results arrive through the Pyodide FFI as
    JsProxy-backed objects; normalizing to plain Python dicts here keeps
    every caller free of FFI details.
    """

    def __init__(self, binding):
        self._db = binding

    async def execute(self, sql: str, params=()) -> list[dict]:
        """Run one bound statement and return all rows as plain dicts.

        Why .run() and not .all(): run() is the D1 call documented for
        both reads and writes with bound parameters; its result carries
        `results` (the rows) and `meta` (changes, duration). M0 finding:
        the Python binding already hands back a real Python list of
        dicts, so no FFI conversion is needed here.
        """
        stmt = self._db.prepare(sql).bind(*params)
        result = await stmt.run()
        rows = result.results
        return list(rows) if rows else []


def get_conn(request):
    """Return the D1 conn for this request, or fail loudly elsewhere.

    Why the request scope: the ASGI bridge (`workers.asgi`) puts the
    bindings object on the ASGI scope as `env`, and the D1 binding is
    `env.DB`. There is no second backend and no dev substitute — a
    request without the binding means the app was not started by
    workerd, which is a bug worth a loud error, not a fallback.
    Routers call this as a dependency and pass the result to db
    functions, so no router ever touches the binding itself.
    """
    env = request.scope.get("env")
    if env is not None and hasattr(env, "DB"):
        return D1Conn(env.DB)
    raise RuntimeError(
        "no D1 binding on the request: the app runs only under workerd "
        "(uv run pywrangler dev)"
    )


def row_to_dict_with_json(row: dict, json_cols) -> dict:
    """Decode JSON-text columns of one row into real structures.

    Why this lives here: SQLite (and D1) have no list/dict column types,
    so lists and maps are stored as JSON text; this is the single spot
    that turns them back into real structures.
    """
    out = dict(row)
    for col in json_cols:
        out[col] = json.loads(out[col])
    return out


def _node_row(row: dict) -> dict:
    """Decode one node row; `config_json` NULL means "no config yet".

    Why decode here and not in callers: the config blob is opaque, but
    "is it set?" is a decision every node endpoint makes, and a decoded
    dict (or None) is the shape the service layer compares against.
    """
    node = dict(row)
    if node["config_json"] is not None:
        node["config_json"] = json.loads(node["config_json"])
    return node


async def list_nodes(conn) -> list[dict]:
    """Return every node, id-ordered (deterministic lists for the UI)."""
    rows = await conn.execute("SELECT * FROM nodes ORDER BY id")
    return [_node_row(row) for row in rows]


async def get_node(conn, node_id) -> dict | None:
    """Fetch one node by id, or None when missing."""
    rows = await conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,))
    return _node_row(rows[0]) if rows else None


async def create_node(conn, node: dict):
    """Insert one complete node row (server-generated fields included).

    Why it takes a complete dict: deciding what values a new node gets is
    business logic that belongs to the service layer; this function only
    knows how to store what it is given. Agent-facing columns start as
    NULL — nothing is filled until an agent reports (M3).
    """
    await conn.execute(
        """
        INSERT INTO nodes (id, label, address, config_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            node["id"],
            node["label"],
            node["address"],
            json.dumps(node["config_json"]) if node.get("config_json") is not None else None,
            node["created_at"],
        ),
    )


async def replace_node(conn, node: dict):
    """Overwrite the editable columns (label, address) of one node.

    Why label/address only: the id is the identity (never renamed via
    update) and `config_json` has its own setter — `set_node_config` —
    because saving a config is a distinct act that also triggers a sync.
    """
    await conn.execute(
        "UPDATE nodes SET label = ?, address = ? WHERE id = ?",
        (node["label"], node["address"], node["id"]),
    )


async def set_node_config(conn, node_id, config):
    """Store (or clear, with None) one node's opaque authored config.

    Why JSON text: the config is a dict the plane never interprets; it is
    stored verbatim so a render reads back exactly what was pasted.
    """
    text = json.dumps(config) if config is not None else None
    await conn.execute(
        "UPDATE nodes SET config_json = ? WHERE id = ?", (text, node_id)
    )


async def set_token_hash(conn, node_id, token_hash):
    """Store one node's bearer-token hash, replacing any previous one.

    Why a replace and not a history: rotation invalidates immediately
    (M3 decision) — the old hash dies the moment the new one is stored,
    so there is exactly one valid token per node at any time.
    """
    await conn.execute(
        "UPDATE nodes SET token_hash = ? WHERE id = ?", (token_hash, node_id)
    )


async def set_reported_address(conn, node_id, address):
    """Store one node's agent-reported address (display only, never links).

    Why a dedicated setter: the reported address is a fact the node states
    about itself at enroll, not editable state like label and address.
    Keeping it out of replace_node makes the split impossible to blur —
    the admin owns the share-link domain, the node owns its own report.
    """
    await conn.execute(
        "UPDATE nodes SET reported_address = ? WHERE id = ?", (address, node_id)
    )


async def touch_node(conn, node_id, last_seen, health, agent_version,
                     xray_version, last_error, applied_hash):
    """Overwrite one node's agent-reported liveness columns in one statement.

    Why one fixed statement: the service layer computes the complete
    desired values first (including the heartbeat cheap-write decision),
    so the SQL never needs a dynamic column list — same reasoning as
    `replace_user`. `last_seen` NULL means "never contacted" (pending).
    """
    await conn.execute(
        """
        UPDATE nodes
        SET last_seen = ?, health = ?, agent_version = ?,
            xray_version = ?, last_error = ?, applied_hash = ?
        WHERE id = ?
        """,
        (last_seen, health, agent_version, xray_version,
         last_error, applied_hash, node_id),
    )


async def list_users(conn) -> list[dict]:
    """Return every user's global row, username-ordered."""
    rows = await conn.execute("SELECT * FROM users ORDER BY username")
    return [dict(row) for row in rows]


async def get_user(conn, username) -> dict | None:
    """Fetch one user's global row by username, or None when not found.

    Why global fields only: status/expire/note are user-wide; the
    per-node access lives in `user_node_access` and is joined by the
    services that need it.
    """
    rows = await conn.execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    )
    return dict(rows[0]) if rows else None


async def create_user(conn, user: dict):
    """Insert the global user row (identity and server facts only)."""
    await conn.execute(
        """
        INSERT INTO users (username, status, expire, note, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            user["username"],
            user["status"],
            user["expire"],
            user["note"],
            user["created_at"],
        ),
    )


async def replace_user(conn, user: dict):
    """Overwrite the editable global columns of one user row.

    Why a full overwrite of just these columns: the service layer merges
    partial changes first, so this stays one fixed SQL statement with no
    dynamic column list — same reasoning as the archived panel.
    """
    await conn.execute(
        "UPDATE users SET status = ?, expire = ?, note = ? WHERE username = ?",
        (user["status"], user["expire"], user["note"], user["username"]),
    )


async def delete_user(conn, username):
    """Delete one user's access rows and then the user row.

    Why access rows first and no return value: the caller observes
    existence before calling (the conn interface returns rows, not
    rowcounts). Removing children first means the worst failure case is
    an orphaned user with no access, never an access row pointing at a
    missing user.
    """
    await conn.execute(
        "DELETE FROM user_node_access WHERE username = ?", (username,)
    )
    await conn.execute("DELETE FROM users WHERE username = ?", (username,))


def _access_row(row: dict) -> dict:
    """Decode one access row's JSON columns into real lists/dicts."""
    return row_to_dict_with_json(row, _ACCESS_JSON_COLS)


async def list_access_for_user(conn, username) -> list[dict]:
    """Return one user's access rows, node-id ordered (deterministic)."""
    rows = await conn.execute(
        "SELECT * FROM user_node_access WHERE username = ? ORDER BY node_id",
        (username,),
    )
    return [_access_row(row) for row in rows]


async def list_access_for_node(conn, node_id) -> list[dict]:
    """Return one node's access rows, username-ordered.

    Why username order: the render pipeline consumes this list directly;
    a deterministic order is what makes two renders of the same database
    state byte-identical, which the content-hash convergence (M3) needs.
    """
    rows = await conn.execute(
        "SELECT * FROM user_node_access WHERE node_id = ? ORDER BY username",
        (node_id,),
    )
    return [_access_row(row) for row in rows]


async def get_access(conn, username, node_id) -> dict | None:
    """Fetch one (user, node) access row, or None when there is none.

    Why it exists: the uuid rule needs the row's existing uuid map to
    keep pairs stable across edits — only genuinely new outbound tags
    mint a uuid.
    """
    rows = await conn.execute(
        "SELECT * FROM user_node_access WHERE username = ? AND node_id = ?",
        (username, node_id),
    )
    return _access_row(rows[0]) if rows else None


async def upsert_access(conn, username, node_id, allowed_inbounds, allowed_outbounds, uuids):
    """Insert or replace one (user, node) access row.

    Why replace and not a partial update: the service layer computes the
    complete desired row (existing uuids merged with new ones) first, so
    the SQL stays one fixed statement. `ON CONFLICT` covers both first
    membership and re-saving an existing one.
    """
    await conn.execute(
        """
        INSERT INTO user_node_access
            (username, node_id, allowed_inbounds, allowed_outbounds, uuids)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(username, node_id) DO UPDATE SET
            allowed_inbounds = excluded.allowed_inbounds,
            allowed_outbounds = excluded.allowed_outbounds,
            uuids = excluded.uuids
        """,
        (
            username,
            node_id,
            json.dumps(allowed_inbounds),
            json.dumps(allowed_outbounds),
            json.dumps(uuids),
        ),
    )


async def delete_access(conn, username, node_id):
    """Remove one (user, node) access row; a missing row is not an error."""
    await conn.execute(
        "DELETE FROM user_node_access WHERE username = ? AND node_id = ?",
        (username, node_id),
    )


async def list_reality_keys(conn, node_id) -> dict:
    """Return one node's REALITY keys as {inbound_tag: {private_key, created_at}}.

    Why keyed by tag: an inbound's tag is its identity within a node's
    config, so the key follows the tag — removing and re-adding an
    inbound with the same tag reuses its key instead of breaking clients.
    """
    rows = await conn.execute(
        "SELECT inbound_tag, private_key, created_at "
        "FROM reality_keys WHERE node_id = ?",
        (node_id,),
    )
    return {row["inbound_tag"]: dict(row) for row in rows}


async def upsert_reality_key(conn, node_id, inbound_tag, private_key, created_at):
    """Insert or overwrite one node's key for one inbound tag.

    Why an upsert: generation (first key for a tag) and rotation (fresh
    key for an existing tag) are the same storage operation — replace
    whatever is stored with the given key and timestamp.
    """
    await conn.execute(
        """
        INSERT INTO reality_keys (node_id, inbound_tag, private_key, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(node_id, inbound_tag) DO UPDATE SET
            private_key = excluded.private_key,
            created_at = excluded.created_at
        """,
        (node_id, inbound_tag, private_key, created_at),
    )


def _profile_row(row: dict) -> dict:
    """Decode one link-profile row's JSON overrides into a real dict."""
    return row_to_dict_with_json(row, _PROFILE_JSON_COLS)


async def list_link_profiles(conn, node_id) -> list[dict]:
    """Return one node's link profiles in deterministic display order."""
    rows = await conn.execute(
        "SELECT * FROM link_profiles WHERE node_id = ? "
        "ORDER BY inbound_tag, id",
        (node_id,),
    )
    return [_profile_row(row) for row in rows]


async def get_link_profile(conn, node_id, profile_id) -> dict | None:
    """Fetch one link profile by node and slug, or None when missing."""
    rows = await conn.execute(
        "SELECT * FROM link_profiles WHERE node_id = ? AND id = ?",
        (node_id, profile_id),
    )
    return _profile_row(rows[0]) if rows else None


async def create_link_profile(conn, profile: dict):
    """Insert one complete link-profile row (server facts included)."""
    await conn.execute(
        """
        INSERT INTO link_profiles
            (node_id, id, inbound_tag, label, overrides, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            profile["node_id"],
            profile["id"],
            profile["inbound_tag"],
            profile["label"],
            json.dumps(profile["overrides"]),
            profile["created_at"],
        ),
    )


async def update_link_profile(conn, profile: dict):
    """Overwrite one profile's inbound, label, and overrides.

    Why a fixed update: the service merges partial changes first, so SQL
    stays one statement. Identity columns are never changed here.
    """
    await conn.execute(
        """
        UPDATE link_profiles
        SET inbound_tag = ?, label = ?, overrides = ?
        WHERE node_id = ? AND id = ?
        """,
        (
            profile["inbound_tag"],
            profile["label"],
            json.dumps(profile["overrides"]),
            profile["node_id"],
            profile["id"],
        ),
    )


async def delete_link_profile(conn, node_id, profile_id):
    """Remove one link profile; a missing row is not an error."""
    await conn.execute(
        "DELETE FROM link_profiles WHERE node_id = ? AND id = ?",
        (node_id, profile_id),
    )
