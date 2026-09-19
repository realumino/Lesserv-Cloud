# M3-PLAN.md — the agent, split out

Executable plan for milestone 3, derived from `PLAN.md`'s M3 done-when list,
`docs/PROTOCOL.md` (`protocol: 1`, binding), `ARCHITECTURE.md`'s "Life of a
change / heartbeat" sections, and the M2 code as it exists
(`render_service`, `node_service`, `user_service`, `xray_service`,
`admin_nodes`, `admin_reality`).

This file is a working checklist. When M3 lands, its outcome (not its
process) folds into `PLAN.md`.

## Goal

The control plane and the node become separate processes on one VPS. The
plane stops managing Xray entirely: no subprocess, no runtime file, no sync
calls. It mints per-node bearer tokens, serves `PROTOCOL.md` v1 (`enroll`,
`heartbeat`, `config`, `report`, `stats`), and shows drift (desired vs
applied hash). The agent (in `Lesserv-Agent`) pulls over localhost every
30s. A user edit propagates with no manual action; bad configs never touch
the live service; crashes converge.

## Done criteria (from PLAN.md, made testable)

| # | Criterion | Proof |
|---|---|---|
| 1 | `enroll` + `heartbeat` authenticate a node | wrong token → 401; token-A with `X-Lesserv-Node: B` → 401; node A can never read node B (explicit test) |
| 2 | User edit propagates ≤30s, no manual action | fake-agent loop: `PUT user` → next `heartbeat` returns new `desired_hash` → `GET config` → `POST report ok` → admin sync endpoint shows `in_sync: true`; no `xray_service` import anywhere |
| 3 | Config failing `xray -test` rejected, live untouched | agent-side (A2) + plane contract: `GET config` returns exact bytes; plane never validates semantics beyond render; test asserts plane serves what it rendered, byte-for-byte |
| 4 | Config passing test but killing Xray on start → rollback + error report | agent-side (A2 step 6–7); plane-side: `POST report {ok:false, stage:"started"}` stores `last_error`, sets `health`, leaves `applied_hash` on last-good; admin sync shows `apply failed, rolled back` |
| 5 | Kill agent mid-apply, restart → converges | agent-side (A3); plane-side: all node endpoints idempotent; `enroll` repeatable; duplicate `heartbeat`/`report` safe; test replays enroll→heartbeat→config→report twice, same state |
| 6 | Broken live config at agent startup → detected, replaced from last-good | agent-side (A3 startup check); plane-side: nothing required beyond idempotent endpoints; verified in agent repo against this plane |
| 7 | `stats` ships from v1 | `POST /api/node/stats` accepts absolute counters + `boot_id`, validates, returns 200; no persistence (M7 owns `node_stats`) |
| 8 | Stopgap deleted | `xray_service.py` gone; no `sync_node(s)` calls; `/api/admin/status` has no `xray_*` fields; runtime pane is a live render, not a file |

## Decisions locked for M3

1. **No schema migration.** `nodes(token_hash, applied_hash, last_seen,
   health, agent_version, xray_version, last_error)` exist since M1. M3 only
   writes them. `migrations/` untouched.
2. **Token lifecycle: mint once, immediate invalidation.**
   `POST /api/admin/nodes/{id}/token` mints 32 random bytes
   (`secrets.token_urlsafe(32)`), stores SHA-256 hex, returns plaintext
   once. Re-POST rotates; old hash dies immediately. No grace window
   (PROTOCOL's option 1 deferred). Admin copies the token to `agent.toml`
   (mode `0600`) by hand.
3. **`pending` vs `active` is derived, not stored.** `last_seen IS NULL` →
   `pending`; any authenticated request → `active`. No status column.
4. **Heartbeat is cheap by conditional write.** Plane `UPDATE`s `nodes` only
   when `now - last_seen > 60s` OR any of
   `health/agent_version/xray_version/last_error/applied_hash` changed. Test
   asserts a second identical heartbeat leaves `last_seen` untouched.
5. **Heartbeat renders (and may mint keys).** `desired_hash =
   config_hash(desired_config(node))`. `ensure_keys` runs inside, so the
   first heartbeat after a config change can INSERT missing REALITY keys.
   Heartbeat is therefore not a pure read — documented here.
6. **No desired state → `desired_hash: null`.** Node without config, or
   malformed config (render returns `(None, [warning])`), yields
   `{desired_hash: null, actions: []}`. Agent treats `null` as "change
   nothing, keep serving". Warnings surface on the admin sync endpoint, not
   in heartbeat.
7. **Unknown `protocol` → 400, explicitly.** `{detail: "unsupported protocol
   N"}`. Agent keeps serving current config (PROTOCOL "never guesses" rule).
   `protocol: 1` only.
8. **`actions` is plumbed but always `[]` in M3.** `restart_xray` stays the
   only defined action; no admin trigger endpoint yet (deferred to M5).
   Heartbeat shape is future-proof without dead UI.
9. **`stats` is accept-and-validate, then discard.** 200 `{accepted: <n>}`;
   validates `boot_id` + `counters` shape; stores nothing (M7 adds
   `node_stats` + accumulation `max(0, new-old)` + boot-reset rule).
   Counters never logged (keys contain emails).
10. **Runtime pane becomes a live render.**
    `GET /api/admin/nodes/{id}/config/runtime` returns `{config, hash,
    warnings}` computed on demand via `desired_config`. 404 when no
    renderable config. The `data/runtime/*.json` files stop being written.
11. **`/api/admin/status` loses local Xray.** Returns `{node_count,
    user_count}` only. Fleet health moves to per-node sync state (M5 builds
    the view; M3 provides the data).
12. **Node token grants nothing on `/api/admin/*`.** Pre-M4 admin is
    unauthenticated localhost by design; the node auth boundary is
    node-vs-node isolation, tested explicitly.
13. **Agent crash-safety lives in the agent repo;** this repo provides the
    idempotent contract + a fake-agent convergence test. Criteria 3–6 are
    verified here at the contract level and end-to-end in `Lesserv-Agent`
    A0–A4 against this plane.

## Explicit deviations and known gaps

- No `304` on config fetch (found by the agent E2E, not by review): the
  first draft 304'd when `?hash=` equaled desired, which is exactly what
  the agent sends — every real fetch would have failed. The contract is
  now 200 on match/omitted, 409 with `desired_hash` on mismatch, and the
  agent verifies the returned hash. No agent-side fetch cache exists, so
  a conditional download would save bytes at the cost of a coherence
  story nobody needs — configs are kilobytes, fetched only on change.
- Heartbeat over localhost is plain HTTP. HTTPS is an M4 production
  property (Access + TLS), not a localhost property.
- No `config_versions` history, no `audit_log`, no node deletion — all later.
- Balancer/proxy-chain qualifier gaps (M2) unchanged.
- `detected_ip` from `enroll` is stored nowhere; returned as suggestion only
  per PROTOCOL (admin decides `address`). Never adopted silently.

## Target module map

### New (Cloud repo)

| File | Job |
|---|---|
| `src/services/node_token_service.py` | Pure-ish token ops: `mint_token()` (secrets, request-time only), `token_hash(token)` (sha256 hex), `verify(stored_hash, presented)` (constant-time) |
| `src/services/node_state_service.py` | Liveness/report rules: `heartbeat_outcome(...)`, `apply_report(...)`, cheap-write decision, `sync_state(conn, node_id)` (desired/applied/in_sync + warnings) |
| `src/routers/node.py` | `POST /api/node/enroll`, `POST /api/node/heartbeat`, `GET /api/node/config`, `POST /api/node/report`, `POST /api/node/stats` + auth dependency |
| `src/routers/admin_tokens.py` (or fold into `admin_nodes.py`) | `POST /api/admin/nodes/{id}/token` mint/rotate |
| `tests/test_node_protocol.py` | enroll/heartbeat/config/report/stats, auth, isolation, idempotency, cheap-write, stale-guard 409 |
| `tests/test_node_token_service.py` | hash/verify, no-entropy-at-import compliance |
| `tests/test_admin_sync.py` | drift endpoint, token mint, runtime-pane live render |

### Adapted

| File | Change |
|---|---|
| `src/db.py` | Add `set_token_hash`, `update_node_liveness` (conditional), `apply_heartbeat_facts`, `apply_report_outcome`; no other SQL changes |
| `src/models.py` | Add `TokenOut`, `EnrollIn/Out`, `HeartbeatIn/Out`, `ReportIn`, `StatsIn`, `NodeSyncOut`; keep `NodeOut` unchanged, add separate sync shape |
| `src/main.py` | Register `node.router` + token routes; extend import-hygiene list |
| `src/services/node_service.py` | `save_config` stores + validates, **no sync call** |
| `src/services/user_service.py` | create/update/delete write rows, **no `sync_nodes`** |
| `src/routers/admin_nodes.py` | runtime pane → live render; `PUT config` message notes "picked up on next heartbeat"; status drops `xray_*` |
| `src/routers/admin_reality.py` | rotate keys, **no sync call** (next heartbeat converges) |
| `tests/test_import_hygiene.py` | Add new service/router modules to poison import |
| `tests/test_app.py` | Lifespan tables unchanged; smoke still green |
| `tests/test_admin_nodes.py`, `test_users.py`, `test_reality_router.py`, `test_node_service.py` | Update: no sync assertions; runtime pane new shape; status new shape |

### Deleted

| File | Why |
|---|---|
| `src/services/xray_service.py` | The M1–M2 stopgap. Plane never touches Xray after M3 |
| `src/settings.py` | Only served `xray_service` (`RUNTIME_DIR`, `XRAY_BINARY`) |
| `tests/test_xray_service.py` | Tests the deleted module |
| `data/runtime/*.json` (gitignored artifacts) | No longer written; safe to remove locally |

## Auth (node side)

- Headers per PROTOCOL: `Authorization: Bearer <token>`,
  `X-Lesserv-Node: <id>`, `Content-Type: application/json`.
- Dependency: look up node by header id → 401 if unknown;
  `compare_digest(stored.token_hash, sha256(presented))` → 401 if no match
  or no stored hash. Never log the header value. All subsequent
  reads/writes scoped to that id; request bodies carry no node id.
- Admin token mint response: `{"node_id": "...", "token":
  "<plaintext-once>", "created_at": ...}`. Plaintext never stored, never
  returned again.

## API surface added/changed

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/api/admin/nodes/{id}/token` | 201 `TokenOut` (plaintext once) | 404 unknown node |
| POST | `/api/node/enroll` | 200 `{id, label, address, state: pending\|active, desired_hash: hex\|null}` | 401 bad token/node, 400 bad protocol |
| POST | `/api/node/heartbeat` | 200 `{desired_hash: hex\|null, actions: []}` | 401, 400 bad protocol |
| GET | `/api/node/config?hash=<h>` | 200 `{hash, config}` when `h` matches desired (or is omitted); 409 with `desired_hash` when stale | 401; 404 no renderable config |
| POST | `/api/node/report` | 200 `{}` | 401, 422 bad stage |
| POST | `/api/node/stats` | 200 `{accepted: n}` | 401, 422 bad shape |
| GET | `/api/admin/nodes/{id}/sync` | 200 `{node_id, desired_hash, applied_hash, in_sync, last_seen, health, agent_version, xray_version, last_error, warnings}` | 404 |
| GET | `/api/admin/nodes/{id}/config/runtime` (changed) | 200 `{config, hash, warnings}` live render | 404 no config/unrenderable |
| GET | `/api/admin/status` (changed) | 200 `{node_count, user_count}` | — |

Request/response shapes follow `docs/PROTOCOL.md` exactly (field names
`applied_hash`, `applied_at`, `xray_running`, `xray_pid`, `agent_uptime`,
`last_error`, `hash/ok/stage/xray_exit_code/error`, `boot_id/counters`).

Report semantics: `ok:true` + `stage in (applied, started)` →
`applied_hash = hash`, `last_error = null`, `health = ok`. `ok:false` →
`applied_hash` unchanged, `last_error = error`, `health =
"error:<stage>"`. `stage` ∈ `fetched/test/applied/started/rolled_back`,
else 422.

## Execution plan

Each step is a reviewable unit: code + tests + the `ARCHITECTURE.md`
section it invalidates, all green together. Read every touched file before
moving on.

### Step 0 — Token lifecycle + auth dependency

Files: add `src/services/node_token_service.py`; edit `src/db.py`
(`set_token_hash`), `src/models.py` (`TokenOut`); add token route; add
`tests/test_node_token_service.py` (+ admin mint test in
`test_admin_sync.py`).

Work: `mint_token` uses `secrets.token_urlsafe(32)` at request time only;
`token_hash` = sha256 hex; `verify` via `hmac.compare_digest`. Mint route:
404 unknown node, else store hash, return plaintext once. Auth dependency in
`routers/node.py`: parse both headers, 401 on any mismatch, attach node row
to request state.

Verify: `uv run python -m unittest tests.test_node_token_service -v`;
manual: mint twice → first token 401s, second works.

Docs: `ARCHITECTURE.md` trust-boundary/node-auth rows become implemented;
note plaintext-once + never-log rule.

### Step 1 — Node protocol endpoints

Files: add `src/routers/node.py`, `src/services/node_state_service.py`;
edit `src/main.py`, `src/models.py`, `src/db.py`; add
`tests/test_node_protocol.py`.

Work: implement the five endpoints per table above. Heartbeat: render
`desired_config`, hash it, conditional liveness write (rule in decision 4),
return `{desired_hash, actions: []}`. Config: re-render, 409 when `?hash=`
is stale else 200 `{hash, config}` with `Cache-Control: no-store`. Report: apply
semantics above. Stats: validate, count, discard. Every endpoint: 401
before any work; 400 on `protocol != 1`; malformed/empty treated as no-op
(heartbeat/config) — never a state change.

Verify: `uv run python -m unittest tests.test_node_protocol -v` — covers
auth, cross-node isolation (`token-A + node-B → 401`, `token-A cannot GET
B's config`), enroll idempotency (twice → same, `active`), heartbeat hash
flip after user edit, config 200/409/404, report ok/fail transitions, stats
200 + invalid 422, duplicate report idempotent, second identical heartbeat
skips `last_seen` write.

Docs: `ARCHITECTURE.md` "Life of a heartbeat" becomes implemented;
heartbeat cheapness rule stated.

### Step 2 — Drift visibility (admin)

Files: add `GET .../sync` (in `admin_nodes.py` or new `admin_sync.py`);
edit `admin_nodes.py` runtime pane → live render; add
`tests/test_admin_sync.py`.

Work: `sync_state` = `desired_config` + `config_hash` (desired) vs stored
`applied_hash` + liveness columns + render warnings. `in_sync =
desired_hash is not None and desired_hash == applied_hash`. Runtime pane
returns live `{config, hash, warnings}`, 404 when unrenderable. Keep
response envelope stable for the future M5 UI.

Verify: `uv run python -m unittest tests.test_admin_sync
tests.test_admin_nodes -v`; manual: fresh node → `desired_hash` set,
`applied_hash` null, `in_sync: false` → fake-agent apply+report →
`in_sync: true`.

Docs: "Show the difference between what a node runs and what it should
run" section updated.

### Step 3 — Delete the stopgap

Files: delete `xray_service.py`, `settings.py`, `test_xray_service.py`;
edit `node_service.py`, `user_service.py`, `admin_reality.py`,
`admin_nodes.py` (status), `test_users.py`, `test_reality_router.py`.

Work: remove all `sync_node(s)` calls + imports; `save_config`/user
CRUD/rotate just write rows. Status → `{node_count, user_count}`. Assert
`grep -r xray_service src tests` empty (except ARCHITECTURE history note).

Verify: full suite green; `grep` check; live: `PUT config` returns 200 and
changes heartbeat hash without any local file/process activity.

Docs: `ARCHITECTURE.md` — `xray_service` section becomes past tense
("deleted in M3"); "Life of a change step 3 is empty" becomes true.

### Step 4 — Hardening + hygiene

Work: import-hygiene list extended (new modules import clean under poisoned
PRNG); no `secrets`/`uuid` at module scope; `Cache-Control: no-store` on
node config + token responses; error bodies carry messages, never secrets;
route-group guard still 404s everything outside the four prefixes (node
routes are inside `/api/node/`).

Verify: `uv run python -m unittest tests.test_import_hygiene
tests.test_route_groups tests.test_app -v`.

### Step 5 — Local VPS split proof (one box, two processes)

Run plane (`uv run uvicorn local:app --app-dir src`), then drive it as the
agent would:

```powershell
uv run python -m unittest discover -s tests -t . -v
curl.exe http://127.0.0.1:8000/api/health
curl.exe -X POST http://127.0.0.1:8000/api/admin/nodes -H "Content-Type: application/json" -d '{\"id\":\"tokyo01\",\"label\":\"Tokyo 01\",\"address\":\"127.0.0.1\"}'
curl.exe -X PUT http://127.0.0.1:8000/api/admin/nodes/tokyo01/config -H "Content-Type: application/json" --data-binary @config\\xray_config.json
curl.exe -X POST http://127.0.0.1:8000/api/admin/nodes/tokyo01/token
# ^ save $TOKEN once
curl.exe -X POST http://127.0.0.1:8000/api/node/enroll -H "Authorization: Bearer $TOKEN" -H "X-Lesserv-Node: tokyo01" -H "Content-Type: application/json" -d '{\"protocol\":1,\"agent_version\":\"0.1.0\",\"xray_version\":\"25.1.1\",\"platform\":\"linux/x86_64\"}'
curl.exe -X POST http://127.0.0.1:8000/api/node/heartbeat -H "Authorization: Bearer $TOKEN" -H "X-Lesserv-Node: tokyo01" -H "Content-Type: application/json" -d '{\"protocol\":1,\"applied_hash\":null,\"xray_running\":false}'
# ^ desired_hash = $DESIRED
curl.exe "http://127.0.0.1:8000/api/node/config?hash=none" -H "Authorization: Bearer $TOKEN" -H "X-Lesserv-Node: tokyo01"
curl.exe -X POST http://127.0.0.1:8000/api/admin/users -H "Content-Type: application/json" -d '{\"username\":\"alice\",\"access\":{\"tokyo01\":{\"allowed_inbounds\":[\"reality\"],\"allowed_outbounds\":[\"niigata\"]}}}'
# next heartbeat must show a different desired_hash with no manual action; report ok; sync shows in_sync:true
```

Agent-repo criteria (A0–A4, verified against this plane): 30s poll with
5s→300s+jitter backoff; tmp-write → `xray -test` → snapshot-last-good →
atomic rename → restart+verify → report; startup live-config check;
kill-mid-apply converge; absolute-counters + `boot_id` stats.

### Step 6 — Closeout

- Full `ARCHITECTURE.md` read-through: no sentence left claiming local
  Xray, runtime files, or sync-on-write.
- `PLAN.md`: M3 row → done; pointer to agent A0–A4 completion.
- Full suite + smoke above green; fold outcome into `PLAN.md`.

## Test inventory

| File | Origin | Coverage |
|---|---|---|
| `tests/test_node_token_service.py` | new | mint/hash/verify, rotation invalidates, wrong-token 401 shape |
| `tests/test_node_protocol.py` | new | all five endpoints, cross-node isolation, idempotency, stale-guard 409, 400-protocol, cheap-write, report transitions, stats validation |
| `tests/test_admin_sync.py` | new | token mint/rotate, sync drift states, runtime live render |
| `tests/test_admin_nodes.py` | updated | new runtime/status shapes, save-config stores without sync |
| `tests/test_users.py`, `test_reality_router.py`, `test_node_service.py` | updated | mutations write without syncing |
| `tests/test_import_hygiene.py` | extended | new modules poison-clean |
| `tests/test_app.py`, `test_route_groups.py`, `test_migrations.py` | unchanged/pinned | guard, lifespan, no new migration |

Run: `uv run python -m unittest discover -s tests -t . -v`

## Out of scope (do not build now)

Access/D1/secrets/key encryption (M4); node #2 + frontend (M5);
subscriptions (M6); stats accumulation + dashboard (M7); quota (M8);
`hmac-v1`, agent self-update, R2 mirror (later); `config_versions`,
`audit_log`, node deletion; grace-window rotation; admin-triggered
`restart_xray`.

## Risks and gotchas

- **Import hygiene.** `secrets`/`uuid` only inside handlers; extend the
  poison test with every new module.
- **Async split.** New services touching `conn` are `async`; token
  hash/verify stay sync pure.
- **One statement per `execute`;** SQLite⊆D1 SQL only (no `RETURNING`).
- **Never log `Authorization`, tokens, UUIDs, private keys, or stats keys.**
  Liveness writes carry versions/health only.
- **Determinism.** Desired hash depends on sorted projections (unchanged);
  heartbeat must not perturb it (key-minting excepted and itself
  deterministic thereafter).
- **`desired_hash: null` is not an error.** Agent and admin UI must render
  "no desired state", not retry harder.
- **Two repos, one contract.** Any field meaning change → new `protocol`
  version, never silent reinterpretation; plane may speak older versions,
  agent never guesses.
