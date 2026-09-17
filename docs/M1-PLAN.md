# M1-PLAN.md — scaffold + node-scoped data model

Executable plan for milestone 1, derived from `PLAN.md`'s done-when list,
`ARCHITECTURE.md`'s locked data model, `docs/M0-FINDINGS.md`'s constraints,
and the archived panel's code and tests (reference only, never imported).

This file is a working checklist. When M1 lands, its outcome (not its
process) folds into `PLAN.md`; this file can then be deleted.

## Goal

Recreate the archived panel's behavior in this repo with a `node` dimension
present from the start: configs, keys, and per-user access all belong to a
node; the render path takes a node; the four route groups are the only
reachable paths. SQLite only, one process, no Cloudflare, no frontend.

## Done criteria (from PLAN.md, made testable)

| # | Criterion | Proof |
|---|---|---|
| 1 | Copied pure-core tests pass unmodified | `tests/test_config_service.py`, `tests/test_share_service.py`'s pure class, plus the M0 copies `test_allocator.py` / `test_x25519.py`; `git diff --no-index` vs the archived files shows import lines only (`backend.` removed) |
| 2 | `nodes.address` replaces `SERVER_ADDRESS` | `settings.SERVER_ADDRESS` no longer exists; `share_service.links_for_user` receives `node["address"]`; test: two nodes with different addresses produce different URIs |
| 3 | `reality_keys` keyed `(node_id, inbound_tag)` | DDL primary key; `reality_service` functions take `node_id`; test: same tag on two nodes holds two keys |
| 4 | Access columns moved to `user_node_access` | `users` loses `allowed_inbounds`/`allowed_outbounds`/`uuids`; nested `access` map in the API; tests cover create/update/delete and uuid stability |
| 5 | Render path takes a node | `render_service.desired_config(conn, node_id)`; test: two nodes render independently from their own configs |
| 6 | Four route groups, fail-closed | `route_groups.is_allowed_path`; middleware 404s everything else; `/docs`, `/openapi.json`, legacy `/api/users`, `/api/spike/*` all 404; test injects a route outside the prefixes and asserts it stays unreachable |
| 7 | Observable behavior otherwise identical | Endpoint-by-endpoint mapping in the API table below; user edit still rewrites the runtime artifact and bounces local Xray |

## Decisions locked for M1

1. **Local Xray stays until M3.** "Still one process" in the milestone text
   means the panel keeps running Xray as a child, as the archived panel did;
   M3's agent split deletes `xray_service` and the `sync` calls. The module
   is written as the panel's stopgap I/O layer, with render logic separated
   into `render_service` so only the file/subprocess shell dies.
2. **Per-node access is a nested map** in the user payload/response:
   `access = {node_id: {allowed_inbounds, allowed_outbounds}}`; `uuids` are
   server-generated and nested per node in responses. One `access` value on
   update is authoritative for membership (rows for unlisted nodes are
   deleted); `access: None` means "leave unchanged"; `access: {}` clears.
3. **REALITY keys are stored plaintext until M4.** `crypto.py` needs
   WebCrypto, which only exists in workerd, and the encryption key is a
   Worker secret that does not exist yet. M4 adds the secret, the `v1:`
   storage format, and a one-time re-encrypt of existing rows.
   `ARCHITECTURE.md`'s key-custody section gets a "from M4" note now.
4. **`uuids` are stored keyed by local outbound** (`{"niigata": "..."}`),
   per the locked data model; the email (`alice@niigata`) is built at
   projection time. M2 changes the projection (prefixes the tag), never the
   stored key.
5. **Generated configs are deterministic.** Projections sort by username
   (and nodes by id where several are combined) so the same database state
   renders byte-identical output — the content-hash convergence property
   M3 depends on. `render_service.config_hash` is included now and tested.
6. **Configs live in the database** (`nodes.config_json`, JSON text), not
   in files. The only file artifact is the local runtime config the stopgap
   Xray process actually reads (`data/runtime/{node_id}.json`).
7. **Node ids are `^[a-z0-9]{1,32}$`.** No hyphens, because M2's qualified
   tags are `{tag}-{node_id}` / `{node_id}-{tag}` and the separator must not
   be ambiguous.
8. **No demo seed and no frontend.** Tests build their own data; the SPA is
   rebuilt at M5. API-level parity is what "identical behavior" means here.

## Explicit deviations from the archived panel

- Paths move under `/api/admin/*` and gain the node dimension
  (`/api/admin/nodes/{id}/config` instead of `/api/config`).
- Config replacement is `PUT` (idempotent replace) instead of `POST`.
- Links are aggregated across every node the user has access to; each link
  carries its `node`; warnings are prefixed with the node id. `409` still
  means "no usable address"; `503` still means "access exists but no node
  config to build links from" for the single-node case.
- `/api/status` loses `config_loaded` (per-node now: a config endpoint
  404s) and gains `node_count`.
- FastAPI's `/docs`, `/redoc`, and `/openapi.json` are disabled — they sit
  outside the four prefixes and the guard is fail-closed.
- No demo user is seeded; users and nodes are created through the API.

## Target module map

### New

| File | Job |
|---|---|
| `src/route_groups.py` | The four allowed prefixes; `is_allowed_path(path)` |
| `src/settings.py` | `RUNTIME_DIR` (`data/runtime`), `XRAY_BINARY` (`xray`), env-overridable |
| `src/models.py` | Pydantic shapes: nodes, per-node access, users, links |
| `src/migrations.py` | Local-only migration runner (D1 uses wrangler on the same files) |
| `migrations/0001_init.sql` | The four tables |
| `src/services/node_service.py` | Node create/update; config save + sync trigger |
| `src/services/render_service.py` | Node → projected users + keys → `(runtime, warnings)`; `config_hash` |
| `src/services/xray_service.py` | Stopgap local runtime: runtime file, subprocess, `sync_node(s)` |
| `src/routers/admin_nodes.py` | Node CRUD, config, runtime pane, inbounds/outbounds, status |
| `src/routers/admin_users.py` | User CRUD, per-node access, aggregated links |
| `src/routers/admin_reality.py` | Node-scoped REALITY list/rotate |
| `tests/support.py` | Temp-file DB with migrations applied |

### Copied from the archived panel (import lines only)

| File | Change |
|---|---|
| `src/services/config_service.py` | `from core import allocator` |
| `src/services/share_service.py` | `from core.x25519 import derive_public_key` |
| `tests/test_config_service.py` | `from services import config_service` |
| `tests/test_share_service.py` | `from services import share_service`; the pure class is untouched, `TestShareRouter` is rewritten node-scoped |

### Adapted

| File | Change |
|---|---|
| `src/db.py` | Node/user/access/key SQL replaces the spike helper; keeps `row_to_dict_with_json` |
| `src/main.py` | Guard middleware, docs disabled, three routers |
| `src/local.py` | Migrations at lifespan instead of inline DDL |
| `src/services/user_service.py` | `ensure_uuids` is tag-keyed; CRUD writes access rows; syncs affected nodes |
| `src/services/reality_service.py` | Every function takes `node_id` |
| `src/routers/health.py` | Unchanged |
| `tests/test_users.py`, `test_reality_*.py`, `test_system.py`, `test_app.py`, `test_import_hygiene.py`, `test_db.py` | Adapted as listed in the test inventory |

### Deleted

`src/routers/spike.py`, `src/checks.py`, `migrations/0001_spike.sql`, the
`SPIKE_MODE` var in `wrangler.jsonc`, the spike tests in `tests/test_app.py`,
and the disposable local state (`data/panel.db`, `.wrangler/state/v3/d1`).

`src/crypto.py` stays — M4 wires it into key storage.

## Schema (`migrations/0001_init.sql`)

```sql
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

CREATE TABLE IF NOT EXISTS user_node_access (
    username          TEXT NOT NULL,
    node_id           TEXT NOT NULL,
    allowed_inbounds  TEXT NOT NULL DEFAULT '[]',
    allowed_outbounds TEXT NOT NULL DEFAULT '[]',
    uuids             TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (username, node_id)
);

CREATE TABLE IF NOT EXISTS reality_keys (
    node_id     TEXT NOT NULL,
    inbound_tag TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (node_id, inbound_tag)
);
```

Agent-facing columns (`token_hash`, `applied_hash`, `last_seen`, `health`,
`agent_version`, `xray_version`, `last_error`) exist from the start because
they are part of the locked data model; M3 fills them. No foreign keys (the
archived panel had none; deletes are explicit in `db.delete_user`). No extra
indexes at this scale. Deferred tables: `link_profiles` (M2),
`config_versions` (with rollback work), `node_stats` (M7), `audit_log` (M4).

## API surface (all `async`)

`/api/health` — unchanged.

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/admin/nodes` | 200 `[NodeOut]` | — |
| POST | `/api/admin/nodes` | 201 `NodeOut` | 409 duplicate id, 422 bad id/label |
| GET | `/api/admin/nodes/{node_id}` | 200 `NodeOut` | 404 |
| PUT | `/api/admin/nodes/{node_id}` | 200 `NodeOut` | 404 |
| GET | `/api/admin/nodes/{node_id}/config` | 200 opaque config | 404 node or no config |
| PUT | `/api/admin/nodes/{node_id}/config` | 200 `{"message": ...}` | 404 node, 422 non-JSON |
| GET | `/api/admin/nodes/{node_id}/config/runtime` | 200 `{config, generated_at}` | 404 not rendered yet |
| GET | `/api/admin/nodes/{node_id}/inbounds` | 200 summaries | 404 node, 503 no config |
| GET | `/api/admin/nodes/{node_id}/outbounds` | 200 summaries | 404 node, 503 no config |
| GET | `/api/admin/nodes/{node_id}/reality` | 200 `{keys: [...]}` | 404 node or no config |
| POST | `/api/admin/nodes/{node_id}/reality/rotate` | 200 `{rotated: [...]}` | 404 no REALITY inbound |
| POST | `/api/admin/nodes/{node_id}/reality/{tag}/rotate` | 200 `{inbound, public_key}` | 404 unknown tag |
| GET | `/api/admin/users` | 200 `[UserOut]` | — |
| POST | `/api/admin/users` | 201 `UserOut` | 409 duplicate, 404 unknown node in access, 422 |
| GET | `/api/admin/users/{username}` | 200 `UserOut` | 404 |
| PUT | `/api/admin/users/{username}` | 200 `UserOut` | 404, 404 unknown node |
| DELETE | `/api/admin/users/{username}` | 204 | 404 |
| GET | `/api/admin/users/{username}/links` | 200 `{username, links, warnings}` | 404 user, 409 no usable address, 503 no node config |
| GET | `/api/admin/status` | 200 `{node_count, user_count, xray_running, xray_pid}` | — |

`NodeOut.has_config` is a convenience flag (`config_json is not None`) so a
list view never fetches N configs.

`UserOut` shape:

```json
{
  "username": "alice", "status": "active", "expire": null, "note": null,
  "created_at": 1758000000,
  "access": {
    "tokyo01": {
      "allowed_inbounds": ["reality"],
      "allowed_outbounds": ["niigata"],
      "uuids": {"niigata": "..."}
    }
  }
}
```

## The render path in M1, and where M2 plugs in

```
db.get_node(node_id).config_json            authored, opaque, local tags
        │
render_service.node_users(conn, node_id)    projection: join users + access,
        │                                   build archived user shape
        │                                   (uuids re-keyed to emails),
        │                                   sorted by username
reality_service.ensure_keys(conn, node_id, config)
        │                                   generates + stores missing keys
        ├─────────────── [M2: qualify_config / qualify_users / qualify_keys]
        │
config_service.build_config(config, users)  copied pure core, untouched
config_service.apply_reality_keys(runtime, keys)
        ▼
(runtime, warnings)  → config_hash(runtime)  →  write runtime file  →  restart
```

`render_service.desired_config(conn, node_id)` returns `(None, [])` for a
node with no config and `(None, [warning])` for a malformed one (the
archived sync's tolerant behavior, made visible). The projection is the
single place M2's qualifier will change; `build_config` and
`apply_reality_keys` must come through M5 untouched.

## Execution plan

Each step is a reviewable commit: code + tests + the `ARCHITECTURE.md`
updates it invalidates, all green together. Read every file before moving on.

### Step 0 — Remove the spike; introduce migrations

Files: delete `src/routers/spike.py`, `src/checks.py`,
`migrations/0001_spike.sql`; edit `wrangler.jsonc` (drop `SPIKE_MODE`); add
`src/migrations.py`, `migrations/0001_init.sql`; edit `src/local.py`
(lifespan applies migrations, no inline DDL); edit `tests/test_app.py`
(spike tests → health only); add `tests/test_migrations.py`; edit
`tests/test_import_hygiene.py` (module list); delete `data/panel.db`.

Work:
- `migrations.py`: `apply_migrations(conn, migrations_dir)` — ensures a
  `schema_migrations` table, runs unapplied `*.sql` in filename order, one
  statement per `execute()` (split on `;` after stripping `--` comments),
  records each filename. Returns the applied names. This is the local half
  of M4's "same files, D1 via wrangler" story.
- `local.py` resolves the migrations dir relative to the repo root
  (`Path(__file__).parent.parent / "migrations"`).

Verify: tests green; `uv run uvicorn local:app --app-dir src` then
`curl.exe http://127.0.0.1:8000/api/health` → 200, `/api/spike/self-check`
→ 404; running twice does not re-apply migrations.

Docs: `ARCHITECTURE.md` — entrypoints section (migrations), delete the
spike/migration references.

### Step 1 — Route groups, fail-closed

Files: add `src/route_groups.py`; edit `src/main.py` (disable docs/redoc/
openapi, register the guard middleware, keep health); add
`tests/test_route_groups.py`; extend `tests/test_app.py`.

Work:
- `PREFIXES = ("/api/admin/", "/api/node/", "/sub/")` — exact string
  prefixes (trailing slash included); allowed iff `path == "/api/health"`
  or `path.startswith(prefix)` for one prefix. `/api/admin` alone → 404
  (no route anyway; fail closed).
- Middleware returns a bare 404 JSON body for anything else, before routing.
- Test the guard function directly (table of paths) and through TestClient:
  a route deliberately added outside the prefixes still 404s; `/docs`,
  `/openapi.json`, `/api/users`, `/api/spike/self-check` 404.

Docs: `ARCHITECTURE.md` — trust boundaries: the guard exists, Access is M4.

### Step 2 — Data layer

Files: rewrite `src/db.py`; add `src/models.py`; add `tests/support.py`;
adapt `tests/test_db.py`; adapt `tests/test_users.py` (models + db + uuid
rule parts); extend `tests/test_reality_service.py`'s storage tests.

Work:
- `db.py` functions (all `async`, all SQL): `list_nodes`, `get_node`
  (decodes `config_json`), `create_node`, `replace_node` (label, address),
  `set_node_config`; `list_users`, `get_user`, `create_user`,
  `replace_user` (status, expire, note), `delete_user` (access rows first,
  then the user row); `list_access_for_user`, `list_access_for_node`
  (`ORDER BY username` — determinism), `get_access`, `upsert_access`,
  `delete_access`; `list_reality_keys(conn, node_id)`,
  `upsert_reality_key(conn, node_id, tag, key, ts)`. Keep `SqliteConn`,
  `D1Conn`, `get_conn`, `row_to_dict_with_json`.
- Existence checks happen before deletes (the conn interface returns rows,
  not rowcounts); `user_service` owns that ordering.
- `models.py`: `NodeCreate` (`id` pattern, non-empty `label`, `address`),
  `NodeUpdate` (all optional), `NodeOut` (+`has_config`), `AccessIn`,
  `UserCreate` (username validator copied from the archive, `access` map),
  `UserUpdate` (`access: dict | None`), `AccessOut`, `UserOut`, `ShareLink`
  (+`node`), `UserLinksOut`.
- `tests/support.py`: `make_db_path()`, `open_fresh_db()` (SqliteConn +
  migrations), cleanup helpers.

Verify: new db tests pass under `IsolatedAsyncioTestCase`; a node and a
user with access round-trip; same inbound tag stores two keys on two nodes.

Docs: `ARCHITECTURE.md` — data model table (nodes columns, access rows,
uuids keyed by local outbound, deferred tables).

### Step 3 — Copy the pure core and its tests

Files: add `src/services/__init__.py`,
`src/services/config_service.py`, `src/services/share_service.py`,
`tests/test_config_service.py`, `tests/test_share_service.py`.

Work: copy the archived files; change only the import lines named in the
module map. Do not touch a function body. Rewrite `TestShareRouter` for the
node-scoped links endpoint (that part is not "copied unmodified").

Verify:
```
git diff --no-index "..\Lesserv\tests\test_config_service.py" tests\test_config_service.py
```
shows import lines only; same for `config_service.py` and `share_service.py`;
`test_share_service.py` shows imports plus the replaced router class.

Docs: `ARCHITECTURE.md` — render pipeline section describes step 3's state
(no qualifier yet).

### Step 4 — Key service and render service

Files: add `src/services/reality_service.py`,
`src/services/render_service.py`; adapt `tests/test_reality_service.py`;
add `tests/test_render_service.py`.

Work:
- `reality_service`: `key_map(conn, node_id)`, `ensure_keys(conn, node_id,
  config)`, `rotate_key(conn, node_id, tag)`, `public_key(conn, node_id,
  tag)`, `list_keys(conn, node_id, config)`. Bodies follow the archive;
  only the key dimension changes.
- `render_service`:
  - `node_users(conn, node_id)` — the projection: access rows joined with
    users, `uuids` re-keyed from `{tag: uuid}` to `{"user@tag": uuid}`,
    sorted by username, status passed through (the copied
    `config_service.user_permissions` still filters active users).
  - `desired_config(conn, node_id)` — config from the node row; `(None, [])`
    when absent; wraps ensure-keys + build + apply in `try/except (KeyError,
    TypeError)` → `(None, ["config looks malformed (...)"])`.
  - `config_hash(runtime)` — sha256 of canonical compact JSON
    (`sort_keys=True`, fixed separators) so formatting never changes it.
- Tests: per-node independence (two nodes, two configs, one user, different
  outputs), disabled user excluded, key injection, malformed config →
  `(None, warning)`, same inputs → same hash, changed input → changed hash,
  uuid map keys visible in the rendered emails.

Docs: `ARCHITECTURE.md` — "The render pipeline" and "Key custody" (plaintext
until M4), "Concepts" (temporary `xray_service`).

### Step 5 — Local runtime (stopgap)

Files: add `src/settings.py`, `src/services/xray_service.py`; add
`tests/test_xray_service.py` (adapted from the archived `test_system.py`'s
file/sync groups).

Work:
- `runtime_path(node_id)`, `write_runtime_config(node_id, config)` (atomic
  temp + replace), `load_runtime_config(node_id)`, `runtime_mtime(node_id)`,
  `start(path)`, `stop()`, `restart(node_id)`, `status()`,
  `binary_available()`, `sync_node(conn, node_id)`, `sync_nodes(conn,
  node_ids)`. The module-level `_process` and `threading.Lock` stay, with
  the archived reasoning.
- `sync_node`: `desired_config` → log warnings → write file → restart.
  Nothing raises; a missing binary is a warning (dev machines).

Tests: write/read/mtime on temp paths, missing/malformed file → `None`,
status for none/running/exited (mocked process), sync writes the rendered
file and calls a mocked restart, sync with no config writes nothing.

Docs: `ARCHITECTURE.md` — note that this module is the M1–M2 stand-in the
M3 split deletes.

### Step 6 — User and node services

Files: add `src/services/user_service.py`, `src/services/node_service.py`;
adapt `tests/test_users.py` (service + sync assertions); add node-service
coverage in `tests/test_admin_nodes.py` or a small `test_node_service.py`.

Work:
- `user_service.ensure_uuids(outbound_tags, uuids)` — tag-keyed, stable.
- `create_user(conn, data)`: global row + one access row per node in
  `data.access` (uuids minted there); then sync every listed node.
- `update_user(conn, username, data)`: merge status/expire/note; when
  `access` is provided, upsert each listed node (existing uuids preserved by
  `ensure_uuids`) and delete rows for unlisted nodes; sync the union of old
  and new node ids; return the user or `None`.
- `delete_user(conn, username)`: existence check, delete access rows + user,
  sync the affected nodes, return bool.
- `node_service.create_node`, `update_node` (partial merge; no sync for
  label/address — links derive at request time), `save_config(conn, node_id,
  payload)` → `set_node_config` + `sync_node`, returning `False` for a
  missing node.

Tests: uuid stability across edits; adding an outbound mints exactly one
uuid; removing a node from the access map deletes its row; 404 paths do not
sync; successful mutations sync exactly the affected node ids.

Docs: `ARCHITECTURE.md` — "Life of a change" adapted to M1 (still local
sync; M3 empties it).

### Step 7 — Admin routers

Files: add `src/routers/admin_nodes.py`, `src/routers/admin_users.py`,
`src/routers/admin_reality.py`; edit `src/main.py`; add
`tests/test_admin_nodes.py`, `tests/test_admin_users.py`; adapt
`tests/test_reality_router.py`, `tests/test_app.py`.

Work: implement the API table above. Routers do HTTP only: `Depends(db.get_conn)`,
existence checks that map to 404/409, and calls into services. The links
endpoint loops the user's access rows (nodes sorted by id): skip nodes
without a config with a `node '<id>' has no config` warning, prefix every
warning with the node id, and keep the archived 404/409/503 decisions.
Reality and config endpoints resolve the node first, then its config.

Verify: full suite; then the live smoke below.

Docs: `ARCHITECTURE.md` — request flows, links section (node address source,
aggregated links), route/API tables.

### Step 8 — Closeout

- Full `ARCHITECTURE.md` read-through: no sentence left claiming
  file-based configs, global `SERVER_ADDRESS`, tag-only `reality_keys`, or
  encryption at rest before M4.
- `PLAN.md`: M1 row → done; one line pointing at what replaced what.
- Final verification below, including the optional workerd smoke.

## Test inventory

| File | Origin | Coverage |
|---|---|---|
| `tests/test_allocator.py` | M0 copy, unchanged | pure allocator |
| `tests/test_x25519.py` | M0 copy, unchanged | RFC 7748 vectors |
| `tests/test_config_service.py` | copied, imports only | fill, BLOCK-first, opacity, REALITY helpers |
| `tests/test_share_service.py` | pure class copied; router class rewritten | URIs, address fallback, node-scoped links |
| `tests/test_db.py` | adapted | conn semantics, SQL round-trips |
| `tests/test_migrations.py` | new | apply once, idempotent, ordered |
| `tests/test_route_groups.py` | new | allowed/blocked paths, guard middleware, injected route stays dead |
| `tests/test_render_service.py` | new | per-node render, determinism, hash, malformed config |
| `tests/test_reality_service.py` | adapted | per-node keys, rotation, listing |
| `tests/test_xray_service.py` | adapted | runtime file, status, sync wiring |
| `tests/test_users.py` | adapted | username rules, uuid stability, CRUD + access, sync triggers |
| `tests/test_admin_nodes.py` | new | node CRUD, config PUT/GET/runtime, inbounds/outbounds, status |
| `tests/test_admin_users.py` | new | user CRUD via HTTP, 404/409, links aggregation, no-address 409 |
| `tests/test_reality_router.py` | adapted | node-scoped reality endpoints |
| `tests/test_app.py` | trimmed | health + guard smoke |
| `tests/test_import_hygiene.py` | extended | no entropy/side effects importing `main`, `local`, `db`, `services.*`, `migrations` |

Run: `uv run python -m unittest discover -s tests -t . -v`

## Final verification

```
uv run python -m unittest discover -s tests -t . -v          # all green
uv run uvicorn local:app --app-dir src --reload              # SQLite backend

curl.exe http://127.0.0.1:8000/api/health
curl.exe http://127.0.0.1:8000/docs                          # 404 (guard)
curl.exe http://127.0.0.1:8000/api/users                     # 404 (legacy path)
curl.exe -X POST http://127.0.0.1:8000/api/admin/nodes -H "Content-Type: application/json" -d '{\"id\":\"tokyo01\",\"label\":\"Tokyo 01\",\"address\":\"funky.example.com\"}'
curl.exe -X PUT  http://127.0.0.1:8000/api/admin/nodes/tokyo01/config -H "Content-Type: application/json" --data-binary @config\xray_config.json
curl.exe http://127.0.0.1:8000/api/admin/nodes/tokyo01/inbounds
curl.exe -X POST http://127.0.0.1:8000/api/admin/users -H "Content-Type: application/json" -d '{\"username\":\"alice\",\"access\":{\"tokyo01\":{\"allowed_inbounds\":[\"GUNMU\"],\"allowed_outbounds\":[\"jijiguo\"]}}}'
curl.exe http://127.0.0.1:8000/api/admin/users/alice/links    # pbk derived from stored key
curl.exe -X POST http://127.0.0.1:8000/api/admin/nodes/tokyo01/reality/GUNMU/rotate
curl.exe http://127.0.0.1:8000/api/admin/nodes/tokyo01/config/runtime   # new key visible

# optional: prove the new code still imports and boots under workerd
uv run pywrangler dev
curl.exe http://127.0.0.1:8787/api/health                    # 200
curl.exe http://127.0.0.1:8787/api/admin/nodes               # guard alive; D1 path is M4
```

Then: `PLAN.md` M1 row updated and this file's remaining open items moved
into the next milestone's notes.

## Out of scope (do not build now)

Qualifier and link profiles (M2); `/api/node/*` auth, enroll, heartbeat,
report, stats (M3); D1 port, Access, secrets, key encryption (M4); frontend,
node #2 (M5); subscriptions (M6); stats (M7); quota (M8); `config_versions`,
`audit_log`, node deletion, docs UI (later).

## Risks and gotchas

- **Import hygiene.** Factory functions stay side-effect free; no
  `os.urandom`/`uuid4` at module scope. Every new service must be added to
  `test_import_hygiene.py`'s poison import.
- **Async split.** Anything using `conn` is `async def`; pure helpers stay
  sync. Tests use `unittest.IsolatedAsyncioTestCase` (stdlib).
- **One statement per `execute`.** The migration runner must split files;
  no multi-statement calls.
- **D1 dialect.** SQL in `db.py` and `migrations/` must stay valid on both
  SQLite and D1: plain `INSERT ... ON CONFLICT DO UPDATE`, no `RETURNING`,
  no window functions.
- **Determinism.** Sort every set that feeds the render (`users` by
  username, nodes by id in links); otherwise content hashes wobble.
- **Opaque config.** Never validate structure in M1; only M2 adds tag-name
  validation at paste time. Never write a qualified name (M1 has none).
- **Private keys.** Never returned, only derived; the rotate response
  carries `public_key`.
- **No fan-out.** User edits do not know which nodes matter — sync takes
  the affected node ids from the access rows, and M3 removes the local sync
  entirely.
