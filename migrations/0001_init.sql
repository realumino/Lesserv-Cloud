-- M1 schema: the node-scoped data model from ARCHITECTURE.md.
--
-- Every table that describes something belonging to a machine carries the
-- node dimension. Agent-facing columns (token_hash, applied_hash, last_seen,
-- health, versions, last_error) exist from the start because they are part
-- of the locked data model; M3 fills them. No foreign keys (same as the
-- archived panel); deletes are explicit. No extra indexes at this scale.
CREATE TABLE IF NOT EXISTS nodes (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    address       TEXT NOT NULL DEFAULT '',
    config_json   TEXT,
    token_hash    TEXT,
    applied_hash  TEXT,
    last_seen     INTEGER,
    health        TEXT,
    agent_version TEXT,
    xray_version  TEXT,
    last_error    TEXT,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    username   TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'active',
    expire     INTEGER,
    note       TEXT,
    created_at INTEGER NOT NULL
);

-- Option B access model: membership is a stored row, never inferred from
-- tag strings. allowed lists and uuids are JSON text; uuids are keyed by
-- local outbound tag ({"niigata": "..."}), scoped by the row's node.
CREATE TABLE IF NOT EXISTS user_node_access (
    username          TEXT NOT NULL,
    node_id           TEXT NOT NULL,
    allowed_inbounds  TEXT NOT NULL DEFAULT '[]',
    allowed_outbounds TEXT NOT NULL DEFAULT '[]',
    uuids             TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (username, node_id)
);

-- Panel-owned REALITY private keys. One per REALITY inbound per node,
-- many per node. Plaintext until M4 adds the Worker secret and the
-- v1:<base64(iv || ct+tag)> format (crypto.py is WebCrypto-only, so the
-- local CPython runtime cannot encrypt).
CREATE TABLE IF NOT EXISTS reality_keys (
    node_id     TEXT NOT NULL,
    inbound_tag TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (node_id, inbound_tag)
);
