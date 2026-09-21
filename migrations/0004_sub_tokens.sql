-- M6: end-user subscription capability tokens.
--
-- The token is stored as plaintext, unlike nodes.token_hash, because the
-- subscription URL must stay re-displayable (it is the user's property and
-- admins re-copy it). A dump already exposes every UUID in
-- user_node_access, so hashing this adds no protection; rotation is the
-- revocation path. Rotation replaces the row value and invalidates the old
-- URL immediately.
ALTER TABLE users ADD COLUMN sub_token TEXT;
ALTER TABLE users ADD COLUMN sub_token_created_at INTEGER;

-- SQLite unique indexes treat NULLs as distinct, so pre-M6 rows (NULL)
-- coexist; the index both enforces uniqueness and serves the token lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sub_token ON users (sub_token);
