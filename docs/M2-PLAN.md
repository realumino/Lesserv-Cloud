# M2-PLAN.md — qualifier + link profiles

Executable plan for milestone 2, derived from `PLAN.md`'s M2 done-when list,
from `ARCHITECTURE.md`'s locked qualifier table and link-profile model, and
from the M1 code as it exists (`render_service`, `share_service`,
`admin_users._collect_links`).

This file is a working checklist. When M2 lands, its outcome (not its
process) folds into `PLAN.md`; this file can then be deleted.

## Goal

The stored config stays identity-free; the rendered config and generated
links carry node-qualified tags; references inside the admin's own routing
rules are rewritten to match; qualification is idempotent and covered by
tests; and link generation produces
`Σ exits × Σ inbounds (1 + extras)` URIs. Labels are readable: stored
labels for nodes and profiles, prettified names for local tags.
`build_config` and `apply_reality_keys` come through this milestone
unchanged.

## Done criteria (from PLAN.md, made testable)

| # | Criterion | Proof |
|---|---|---|
| 1 | Stored config uses local tags | `nodes.config_json` is unchanged by renders and link generation |
| 2 | Rendered config carries qualified tags | runtime inbound tags are `reality-tokyo01`; outbound tags are `tokyo01-niigata` |
| 3 | Admin routing references are rewritten | authored `outboundTag`, `inboundTag[]`, and trailing `@tag` user references render qualified |
| 4 | Qualification is idempotent | qualifying any supported input twice equals qualifying it once |
| 5 | Links produce `Σ exits × Σ inbounds (1 + extras)` | two inbounds, two exits, one profile on one inbound yields six URIs |
| 6 | Labels are readable | each link carries `label` such as `Tokyo 01 · REALITY → Niigata`; URI fragments use the label |
| 7 | Pure core is unchanged | `config_service.py` differs from the archived source by import lines only |

## Decisions locked for M2

1. **The qualifier is pure and new.** `src/services/qualify_service.py`
   contains only synchronous transformations and no database access.
2. **Idempotency is structural.** Node ids cannot contain hyphens, so an
   inbound ending in `-{node_id}` and an outbound beginning with
   `{node_id}-` are recognized as already qualified.
3. **`BLOCK` is exempt everywhere.** It is not prefixed or suffixed, whether
   it appears as an outbound, routing reference, access entry, or stored tag.
4. **Paste-time validation rejects invalid names.** A local tag that is blank
   or already qualified for that node fails the save with 422. Valid tags
   are never modified on read or write.
5. **Stored keys remain local.** `ensure_keys` still records keys under local
   inbound tags. Qualified key names exist only in render/link output.
6. **Link profiles are client-side only.** They never alter the rendered
   config, `config_hash`, local runtime file, or Xray process. Profile edits
   do not sync nodes.
7. **A profile belongs to one local inbound on one node.** Its identity is
   `(node_id, id)` with a short admin-chosen slug.
8. **Overrides are an allowlisted JSON overlay.** They are merged after the
   direct URI parameters are computed. Overrides may change connection
   details such as address, port, host, path, SNI, security, fingerprint,
   ALPN, mode, or service name, but they may not replace key-derived or
   inbound-owned values.
9. **Links use qualified machine-readable names and readable labels.** The
   email, inbound, and outbound fields are qualified. A separate `label`
   field supplies the display name, and the URI fragment uses the label when
   one is available.
10. **Introspection remains local.** Inbound, outbound, and REALITY endpoints
    continue to expose authored local tags, matching stored access lists.

## Explicit deviations and known gaps

- Qualifying every node changes its first M2 `config_hash`. There is no
  agent yet, so the resulting one-time runtime drift is expected and local.
- `routing.balancers[].selector` and chained `outbounds[].proxySettings.tag`
  references are not rewritten. Balancers and proxy chains are uncommon, and
  an admin using them should write qualified names directly.
- Profile management does not validate every possible Xray transport
  combination. It validates storage shape, identity, inbound attachment, and
  the override allowlist; Xray remains the authority on config semantics.

## Target module map

### New

| File | Job |
|---|---|
| `src/services/qualify_service.py` | Pure qualification, identity checks, paste-time errors |
| `src/services/labels.py` | Tag prettification and readable link labels |
| `src/services/link_profile_service.py` | Profile validation andCRUD over the database |
| `src/services/link_service.py` | Per-node link orchestration across access, keys, profiles, and labels |
| `src/routers/admin_link_profiles.py` | Profile CRUD endpoints |
| `migrations/0002_link_profiles.sql` | `link_profiles` table |
| `tests/test_qualify_service.py` | Rewrite rules, idempotency, BLOCK, copying, validation |
| `tests/test_labels.py` | Prettified tags and link labels |
| `tests/test_link_profiles.py` | Profile API behavior and HTTP status codes |
| `tests/test_link_service.py` | Qualified links, profile multiplication, ordering, warnings |

### Adapted

| File | Change |
|---|---|
| `src/services/render_service.py` | Qualify config, users, and keys before the pure fill |
| `src/services/share_service.py` | Optional profiles, labels, remarks, profile-aware address check |
| `src/services/node_service.py` | Validate tags in `save_config`; report existence and errors |
| `src/routers/admin_nodes.py` | Map config-save outcomes to 200, 404, and 422 |
| `src/routers/admin_users.py` | Delegate qualified link generation to `link_service` |
| `src/models.py` | Link-profile models and expanded share-link shape |
| `src/db.py` | Link-profile SQL |
| `src/main.py` | Register the profile router |
| `tests/test_render_service.py` | Qualified render expectations and storage assertions |
| `tests/test_share_service.py` | New profile/label behavior; copied cases unchanged |
| `tests/test_admin_users.py` | Qualified links, labels, and profile counts |
| `tests/test_admin_nodes.py` | 422 on pre-qualified paste |
| `tests/test_node_service.py` | New `save_config` contract |
| `tests/test_db.py` | Profile round-trips |
| `tests/test_migrations.py` | Both migrations |
| `tests/test_import_hygiene.py` | Include the new service modules |

### Deleted

None for M2. This plan file is removed after its outcome is folded into
`PLAN.md`.

## Qualifier behavior

| Target | Rule | Example |
|---|---|---|
| `inbounds[].tag` | suffix | `reality` → `reality-tokyo01` |
| `outbounds[].tag` | prefix, except `BLOCK` | `niigata` → `tokyo01-niigata` |
| `routing.rules[].outboundTag` | prefix, except `BLOCK` | `niigata` → `tokyo01-niigata` |
| `routing.rules[].inboundTag[]` | suffix | `xhttp` → `xhttp-tokyo01` |
| `routing.rules[].user[]` | rewrite a trailing `@tag`, literal or after `regexp:` | `.*@niigata$` → `.*@tokyo01-niigata$` |
| access `allowed_inbounds` | suffix | `["reality"]` → `["reality-tokyo01"]` |
| access `allowed_outbounds` | prefix, except `BLOCK` | `["niigata"]` → `["tokyo01-niigata"]` |
| user `uuids` keys | rewrite the part after `@` | `alice@niigata` → `alice@tokyo01-niigata` |
| reality key-map keys | suffix | `{"reality": k}` → `{"reality-tokyo01": k}` |
| profile grouping | suffix, grouped by qualified inbound | `xhttp` profiles attach to `xhttp-tokyo01` links |

Rewriting uses the config's own known tag set, so unknown references pass
through untouched. Qualification returns new values and never mutates its
inputs.

## Render and links after M2

```text
authored config (local)
  → node_users (local)
  → ensure_keys (stored under local tags)
  → qualify_config / qualify_users / qualify_keys
  → build_config / apply_reality_keys
  → qualified runtime and content hash
```

Links follow the same qualification read-only. Profiles are then applied as
extra URI variants for their attached inbound. A profile never affects the
rendered artifact.

A direct link for `alice`, inbound `reality`, exit `niigata`, and node label
`Tokyo 01` carries:

```json
{
  "node": "tokyo01",
  "inbound": "reality-tokyo01",
  "outbound": "tokyo01-niigata",
  "email": "alice@tokyo01-niigata",
  "profile": null,
  "label": "Tokyo 01 · REALITY → Niigata",
  "uri": "vless://...#Tokyo%2001%20%C2%B7%20REALITY%20%E2%86%92%20Niigata"
}
```

A CDN profile variant changes only its own variant:

```json
{
  "profile": "cdn",
  "label": "Tokyo 01 · CDN → Niigata",
  "uri": "vless://...@cdn.example.com:443?...#..."
}
```

## Schema (`migrations/0002_link_profiles.sql`)

```sql
CREATE TABLE IF NOT EXISTS link_profiles (
    node_id     TEXT NOT NULL,
    id          TEXT NOT NULL,
    inbound_tag TEXT NOT NULL,
    label       TEXT NOT NULL,
    overrides   TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (node_id, id)
);
```

## API surface added

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/admin/nodes/{node_id}/link-profiles` | 200 `[LinkProfileOut]` | 404 unknown node |
| POST | `/api/admin/nodes/{node_id}/link-profiles` | 201 `LinkProfileOut` | 404 node, 409 duplicate id, 422 invalid slug/label/inbound/overrides |
| GET | `/api/admin/nodes/{node_id}/link-profiles/{profile_id}` | 200 `LinkProfileOut` | 404 |
| PUT | `/api/admin/nodes/{node_id}/link-profiles/{profile_id}` | 200 `LinkProfileOut` | 404, 422 |
| DELETE | `/api/admin/nodes/{node_id}/link-profiles/{profile_id}` | 204 | 404 |

`PUT /api/admin/nodes/{node_id}/config` additionally returns 422 when a
stored inbound or outbound tag is blank or already qualified for that node.

`LinkProfileOut` shape:

```json
{
  "id": "cdn",
  "inbound_tag": "xhttp",
  "label": "CDN",
  "overrides": {
    "address": "cdn.example.com",
    "port": 443,
    "security": "tls",
    "sni": "cdn.example.com",
    "host": "cdn.example.com"
  },
  "created_at": 1758000000
}
```

Allowed override keys:

```text
address, port, host, path, sni, security, fp, alpn, mode, serviceName
```

## Execution plan

Each step is a reviewable unit: code, tests, and the `ARCHITECTURE.md`
updates it invalidates, all green together. Read every touched file before
moving on.

### Step 1 — Qualifier and labels

Files: add `src/services/qualify_service.py`, `src/services/labels.py`,
`tests/test_qualify_service.py`, `tests/test_labels.py`; extend
`tests/test_import_hygiene.py`.

Work:

- Implement inbound suffixing, outbound prefixing, `BLOCK` exemption,
  reference rewriting, user/key/profile transformations, deep copying, and
  paste-time errors.
- Implement tag prettification and readable link labels.
- Cover every rewrite rule, idempotency, allocation-safe references,
  copy semantics, and label examples.

Verify:

```powershell
uv run python -m unittest tests.test_qualify_service tests.test_labels -v
```

Docs: `ARCHITECTURE.md` — the qualifier becomes the implemented design;
retain balancers and proxy chains as documented gaps.

### Step 2 — Render through the qualifier

Files: edit `src/services/render_service.py`; update
`tests/test_render_service.py`.

Work:

- Continue calling `ensure_keys` with the authored config.
- Qualify the authored config, projected users, and stored keys before
  `build_config` and `apply_reality_keys`.
- Do not alter `config_service.py`.

Verify:

```powershell
uv run python -m unittest tests.test_render_service -v
git diff --no-index ..\Lesserv\backend\services\config_service.py src\services\config_service.py
```

The code diff must show only the approved import difference.

Docs: `ARCHITECTURE.md` — render order and qualified key names in output.

### Step 3 — Paste-time tag validation

Files: edit `src/services/node_service.py` and
`src/routers/admin_nodes.py`; update `tests/test_node_service.py` and
`tests/test_admin_nodes.py`.

Work:

- Validate a config payload before writing it.
- Return separate node-existence and validation results from the service.
- Return 404 for a missing node, 422 for invalid tags, and 200 after a valid
  write and sync.
- Ensure an invalid payload is neither stored nor synced.

Verify:

```powershell
uv run python -m unittest tests.test_node_service tests.test_admin_nodes -v
```

Docs: `ARCHITECTURE.md` — tag-name validation remains the only paste-time
structural check.

### Step 4 — Link-profile storage

Files: add `migrations/0002_link_profiles.sql`; edit `src/db.py` and
`src/models.py`; update `tests/test_migrations.py` and `tests/test_db.py`.

Work:

- Add the table using SQLite/D1-compatible SQL and JSON text overrides.
- Add ordered list/get/create/update/delete database operations.
- Validate profile slugs, labels, and override shapes at the model boundary.
- Keep profile `inbound_tag` values local in storage.

Verify:

```powershell
uv run python -m unittest tests.test_migrations tests.test_db -v
```

Docs: `ARCHITECTURE.md` — add the implemented `link_profiles` row.

### Step 5 — Link-profile API

Files: add `src/services/link_profile_service.py` and
`src/routers/admin_link_profiles.py`; edit `src/main.py`; add
`tests/test_link_profiles.py`.

Work:

- Validate that a profile attaches to an inbound in the node's authored
  config.
- Enforce slug uniqueness per node and the override allowlist.
- Keep profile CRUD free of runtime sync or restart side effects.
- Map missing nodes/profiles, duplicate ids, and validation failures to
  404, 409, and 422 respectively.

Verify:

```powershell
uv run python -m unittest tests.test_link_profiles -v
```

Docs: `ARCHITECTURE.md` — profile endpoints and the client-side-only rule.

### Step 6 — Profile-aware qualified links

Files: refactor `src/services/share_service.py`; add
`src/services/link_service.py`; edit `src/routers/admin_users.py` and
`src/models.py`; extend `tests/test_share_service.py`; update
`tests/test_admin_users.py`; add `tests/test_link_service.py`.

Work:

- Split link generation into small helpers for config indexing, per-exit
  link assembly, per-inbound variants, and labels.
- Generate the direct URI followed by one URI per profile attached to the
  same inbound.
- Qualify machine-readable link fields before generation.
- Use profile labels and readable remarks without changing pure behavior
  when profiles and labels are absent.
- Consider a profile-provided address for node addressability and warn for
  dangling profiles.
- Preserve link sort order and deterministic output.

Verify:

```powershell
uv run python -m unittest tests.test_share_service tests.test_link_service tests.test_admin_users -v
```

Docs: `ARCHITECTURE.md` — link formula, qualified fields, labels, remarks,
warnings, and ordering.

### Step 7 — Closeout

- Read all of `ARCHITECTURE.md` for stale M1-only or premature M2-future
  wording.
- Mark M2 complete in `PLAN.md`.
- Run the full suite and live smoke test below.
- Fold this plan's outcome into `PLAN.md` and remove this working file.

## Test inventory

| File | Origin | Coverage |
|---|---|---|
| `tests/test_qualify_service.py` | new | every rewrite, idempotency, BLOCK, copying, validation |
| `tests/test_labels.py` | new | readable tags and link labels |
| `tests/test_link_profiles.py` | new | profile CRUD, 404/409/422, no sync |
| `tests/test_link_service.py` | new | qualified links, profile count, labels, warnings |
| `tests/test_render_service.py` | updated | qualified runtime, local storage, deterministic hash |
| `tests/test_share_service.py` | extended | profile variants, remarks, addresses; copied cases unchanged |
| `tests/test_admin_users.py` | updated | endpoint-level qualified links and profiles |
| `tests/test_admin_nodes.py` | updated | rejected qualified paste |
| `tests/test_node_service.py` | updated | existence and validation contract |
| `tests/test_db.py` | updated | profile SQL round-trips |
| `tests/test_migrations.py` | updated | both migrations, applied once |
| `tests/test_import_hygiene.py` | extended | new service modules import cleanly |

Run:

```powershell
uv run python -m unittest discover -s tests -t . -v
```

## Final verification

```powershell
uv run python -m unittest discover -s tests -t . -v
git diff --no-index ..\Lesserv\backend\services\config_service.py src\services\config_service.py
git diff --no-index ..\Lesserv\tests\test_config_service.py tests\test_config_service.py
uv run uvicorn local:app --app-dir src --reload

curl.exe http://127.0.0.1:8000/api/health
curl.exe -X POST http://127.0.0.1:8000/api/admin/nodes -H "Content-Type: application/json" -d '{\"id\":\"tokyo01\",\"label\":\"Tokyo 01\",\"address\":\"funky.example.com\"}'
curl.exe -X PUT http://127.0.0.1:8000/api/admin/nodes/tokyo01/config -H "Content-Type: application/json" --data-binary @config\\xray_config.json
curl.exe -X POST http://127.0.0.1:8000/api/admin/nodes/tokyo01/link-profiles -H "Content-Type: application/json" -d '{\"id\":\"cdn\",\"inbound_tag\":\"xhttp\",\"label\":\"CDN\",\"overrides\":{\"address\":\"cdn.example.com\",\"port\":443}}'
curl.exe -X POST http://127.0.0.1:8000/api/admin/users -H "Content-Type: application/json" -d '{\"username\":\"alice\",\"access\":{\"tokyo01\":{\"allowed_inbounds\":[\"reality\",\"xhttp\"],\"allowed_outbounds\":[\"niigata\"]}}}'
curl.exe http://127.0.0.1:8000/api/admin/users/alice/links
curl.exe http://127.0.0.1:8000/api/admin/nodes/tokyo01/config/runtime
```

The links response must show qualified link fields, direct plus profile
variants, labels, and profile-aware addresses. The runtime pane must show
qualified inbound/outbound tags. A pasted pre-qualified tag must return 422.

## Out of scope (do not build now)

The M3 agent and `/api/node/*`; Access, D1, secrets, or key encryption;
node #2 and the new frontend; subscriptions; stats and quota; balancer and
proxy-chain rewriting; profile display ordering controls; version history or
audit logging.

## Risks and gotchas

- **Import hygiene.** Keep every app module free of import-time entropy and
  extend the poison-import test for every newly imported service.
- **Async split.** Database and service orchestration remain `async`;
  qualification, labels, URI assembly, and override merging remain pure.
- **One statement per `execute`.** Keep SQL wrapper-compatible across SQLite
  and D1.
- **No qualified storage.** Reject qualified tags before they can be saved;
  qualify only render and link output.
- **No non-profile behavior drift.** Calls without profiles, labels, or node
  metadata must preserve archived outputs.
- **Determinism.** Sort users, profiles, inbounds, outbounds, and generated
  links so equal database state produces equal results.
- **Private keys.** Profiles, links, and labels never expose a private key.
- **No profile-triggered sync.** A profile mutation must not rewrite the
  runtime file or restart Xray.
