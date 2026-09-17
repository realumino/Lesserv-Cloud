-- M0 spike schema: the smallest table that proves a D1 round-trip.
--
-- Why this shape: the real table this mirrors is reality_keys
-- (M1 replaces this file with the actual schema). Storing an
-- AES-GCM value as TEXT here proves the full custody path --
-- encrypt via WebCrypto FFI, store, read back, decrypt -- before
-- that path is wired into real key management.
CREATE TABLE IF NOT EXISTS spike_kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);
