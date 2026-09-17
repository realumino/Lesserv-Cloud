-- M2 schema: per-inbound, client-side link variants.
--
-- Profiles describe how a client reaches an existing inbound through an
-- extra front (for example, CDN). They are stored against local inbound
-- tags and never enter the rendered runtime config.
CREATE TABLE IF NOT EXISTS link_profiles (
    node_id     TEXT NOT NULL,
    id          TEXT NOT NULL,
    inbound_tag TEXT NOT NULL,
    label       TEXT NOT NULL,
    overrides   TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (node_id, id)
);
