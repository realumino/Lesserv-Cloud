# PLAN.md — Lesserv-Cloud milestone roadmap

This file holds the project's volatile state: what is done, what is next.
Stable context (architecture, conventions, how to run) lives in
`AGENTS.md`; the walkthrough lives in `ARCHITECTURE.md`.

## What "rendering" means in this file

The control plane owns the transformation from stored state to a node's
runtime Xray config. For one node it is exactly four steps, always in this
order:

1. `qualify_config` — the authored config is identity-free (`reality`,
   `xhttp`, `niigata`). Qualification appends the node id to inbound tags
   (`reality-tokyo01`), prefixes it to outbound tags (`tokyo01-niigata`),
   leaves `BLOCK` untouched, and rewrites tag references inside the
   admin's own `routing.rules`.
2. `qualify_users` — the access rows for that node get the same treatment:
   inbound lists, outbound lists, and the uuid map keys.
3. `qualify_keys` — REALITY keys become keyed by qualified inbound tag.
4. `build_config` + `apply_reality_keys` — the unchanged pure core fills
   `settings.clients` from the authorized users and appends the generated
   routing rules, then injects the panel-owned private keys.

Nothing is stored in qualified form. The qualified names exist only in the
rendered artifact and in generated share links, which is why renaming a
node id is a single row update rather than a migration.

## Current status: M4 complete — the control plane is deployed

M1 recreated the archived panel's behavior with the `node` dimension
wired in from the start: configs, REALITY keys, and per-user access are
all node-scoped, the render path takes a node (`render_service`), the
fail-closed route-group guard is live, and the agent-facing columns of
`nodes` wait for M3. 143 tests pass locally (SQLite backend); the pure
core (`config_service`, `share_service`, `allocator`, `x25519`) is copied
with import lines as the only diff. The executable plan and its decisions
live in [`docs/M1-PLAN.md`](docs/M1-PLAN.md). M2 qualified stored local
tags at render and link-generation time, added per-inbound link profiles
and readable link labels, rejected pre-qualified tags at paste time, and
left `build_config` and `apply_reality_keys` unchanged. 172 tests pass
locally (SQLite backend). The executable plan and its decisions live in
[`docs/M2-PLAN.md`](docs/M2-PLAN.md). M3 split the processes: the plane
serves `protocol: 1` (`enroll`, `heartbeat`, `config`, `report`, `stats`),
mints per-node bearer tokens, shows drift on `GET .../sync`, and manages
no Xray — `xray_service.py` and `settings.py` are deleted, the runtime
pane is a live render, and user edits converge on next heartbeat with no
push. 194 tests pass locally (SQLite backend). The executable plan and
its decisions live in [`docs/M3-PLAN.md`](docs/M3-PLAN.md). M0 ran
local-only (`pywrangler dev` + local D1, no Cloudflare account), per the
rule below.

M4 deployed the plane with zero agent-side changes: the same FastAPI app
runs as a Python Worker on the operator's own hostname (hostname, D1
database, and other account values are deliberately absent from this
public repo — see `docs/DEPLOY.md`) with D1 as the store (`db.py`
signatures unchanged — the M1 async groundwork made the port a proof
rather than a rewrite), migrations applied cleanly to the fresh remote
D1, Cloudflare Access now guards `/api/admin/*` and `/admin/*` (one broad
allow app + three bypass apps; an Access bypass for path `/` matches
*every* path, so the root is deliberately protected instead of public),
the admin SPA ships as a placeholder under `frontend/` and is served
from static assets at `/admin` with the matching Vite `base`, and
REALITY private keys are stored as `v1:` AES-GCM ciphertext under the
`REALITY_KEY_SECRET` Worker secret — with one production lesson folded
into `key_cipher` (PowerShell pipes a BOM into secrets). `docs/PROTOCOL.md`
is frozen at `protocol: 1`, pinned by a test. 201 tests pass locally
(SQLite backend). The deployed smoke — the full protocol sequence plus
sealed-key and Access-bypass checks — passes against the live plane; the
runbook and evidence live in [`docs/DEPLOY.md`](docs/DEPLOY.md). The one
remaining acceptance item is operator-run: point the real agent on the
VPS at the deployed plane (exact commands in `docs/DEPLOY.md`). The
executable plan and its decisions live in
[`docs/M4-PLAN.md`](docs/M4-PLAN.md).

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Spike: platform viability | done |
| 1 | Scaffold + node-scoped data model (one node, SQLite) | done |
| 2 | Qualifier + link profiles | done |
| 3 | The agent, split out (systemd, pull over localhost) | done |
| 4 | Control plane on Workers + D1 | done (agent-on-VPS run = operator step) |
| 5 | Node #2 + the new frontend | not started |
| 6 | Subscriptions | not started |
| 7 | Stats + dashboard | not started |
| 8 | Quota enforcement | not started |
| — | HMAC request signing (`hmac-v1`) | later |
| — | Agent self-update | later |
| — | Release-artifact mirror on R2 (for nodes that can't reach GitHub) | later |

## Milestones

### M0 — Spike: platform viability

Prove the target before committing to it. Everything about reusing the
archived panel's Python core hangs on this, so it is first.

Done when: (a) the same FastAPI `app` object runs under `uvicorn` locally
and inside a Worker; (b) `x25519` and `allocator` run unmodified under
Pyodide and the RFC 7748 vectors pass there; (c) a D1 row round-trips
through `db.py`; (d) AES-GCM encrypt/decrypt works via the JS FFI or a
small JS helper, and the ciphertext round-trips through D1; (e) the
`TestClient` suite still passes locally.

If (a) fails, the fallback is contained: the pure modules are ordinary
Python and run fine under Pyodide, so only the HTTP layer changes — a
hand-rolled `fetch(request)` dispatcher, or TypeScript with Hono. The
verdict is the deliverable, not the code.

### M1 — Scaffold + node-scoped data model

Executable plan: [`docs/M1-PLAN.md`](docs/M1-PLAN.md) (step-by-step,
decision-by-decision, with the test inventory and verification commands).

Recreate the archived panel's behavior here with a `node` dimension
present from the start, still on SQLite, still one process.

Done when: the copied pure-core tests pass unmodified; `nodes.address`
replaces `SERVER_ADDRESS` as the source of share-link addresses;
`reality_keys` is keyed `(node_id, inbound_tag)`; the two per-user access
columns have moved to `user_node_access` rows; the render path takes a node
as an argument rather than assuming "the" config; and the four route groups
exist with the fail-closed prefix check. Observable behavior is otherwise
identical to the archived panel.

### M2 — Qualifier and link profiles

Done when: the stored config uses local tags; the rendered config carries
qualified tags; references inside the admin's own routing rules are
rewritten to match; qualification is idempotent and covered by tests; link
generation produces `Σ exits × Σ inbounds (1 + extras)` URIs; and labels
are readable (stored labels for nodes and profiles, prettified names for
local tags).

Complete: storage remains local; renders, links, profile variants, labels,
and paste-time validation implement the above. The executable record is in
[`docs/M2-PLAN.md`](docs/M2-PLAN.md).

This is where the archived panel's pure core stops being "copied" and
starts being extended. `build_config` and `apply_reality_keys` must come
through this milestone unchanged — if they need editing, the qualifier is
doing its job wrong.

### M3 — The agent, split out

The architectural break, done on one VPS: the control plane and the node
become separate processes, and the control plane stops managing Xray
entirely. The agent lives in the `Lesserv-Agent` repo; this milestone is
complete when that repo's A0–A4 are complete and this one serves it.

Done when: `enroll` and `heartbeat` authenticate a node; a user edit
propagates to the node within 30s without any manual action; a config that
fails `xray -test` is rejected and the live config is untouched; a config
that passes the test but kills Xray on start triggers a rollback to
last-good plus an error report; killing the agent mid-apply and restarting
it converges; and a broken live config at agent startup is detected and
replaced from last-good.

Complete: the plane serves `protocol: 1` with node-vs-node isolation
tested, heartbeat writes are conditional (>60s stale or changed facts),
reports adopt the hash only on `applied`/`started` success, `stats` is
accepted and counted but not stored (M7), and the stopgap is deleted —
no sync calls, no runtime files, no local Xray. Agent-side crash safety
(A2–A3 apply sequence) is proven live, not just at contract level:
`Lesserv-Agent/tests/test_e2e_pull.py` runs the real agent loop against
a real local plane (convergence, rejection with live untouched, rollback
to last-good, kill-mid-apply, startup repair, stats path, auth failure).
That E2E caught one real bug: the first draft returned `304` for the
exact fetch the agent legitimately makes, so the contract is now 200 on
match/omitted and 409 with `desired_hash` on mismatch, with agent-side
hash verification (`docs/PROTOCOL.md`). The executable record is in
[`docs/M3-PLAN.md`](docs/M3-PLAN.md).

### M4 — Control plane on Workers + D1

Done when: the agent converges against the deployed control plane **with
zero code changes** — that is the proof the pull protocol was right;
`db.py`'s function signatures are unchanged but its bodies speak D1;
routers and services are `async`; migrations apply cleanly to a fresh D1;
Cloudflare Access protects the admin surface (an Access application for
the whole hostname plus bypass policies for `/`, `/sub/*`, `/api/node/*`,
and `/api/health`); the SPA is served under `/admin` with SPA fallback and
a matching Vite `base`; and REALITY private keys are unreadable without the
Worker's secret. `docs/PROTOCOL.md` is frozen at `protocol: 1` here.

Expect the async conversion to touch more than `db.py` — the pure modules
stay synchronous, and everything else acquires `async def` and `await`.

### M5 — Node #2 and the new frontend

Done when: two nodes converge independently and neither can observe the
other; the fleet view shows per-node health, last-seen, applied hash, and
last error; node detail pages expose config (authored vs rendered), keys,
and the users authorized for that node; and the user form expresses access
as per-node sections (node label as the header, local tags inside) so the
admin never types a qualified name. The frontend is rebuilt in TypeScript
with a router and a real Tailwind build, and `/admin/nodes/tokyo01/config`
is a real, refreshable URL.

Adding node #2 must require no code change anywhere. If it does, M4's
generality claim was wrong.

### M6 — Subscriptions

Done when: a user has a rotatable `sub_token`; `/sub/{token}` returns the
base64 newline-joined list of every link the user is entitled to, across
every node, with each link carrying its own node's address; disabled or
expired users get an empty body rather than an error; and adding node #2
enriches an existing subscription URL without changing it.

### M7 — Stats and dashboard

Done when: the render ensures the Xray `api`, `stats`, and `policy`
sections exist and are correct (the panel's fifth owned config place); the
agent polls the local Xray API and reports counters; the plane accumulates
per (user, node, exit) traffic handling Xray restarts correctly; and the
dashboard shows it. Quota is not enforced here — this milestone only
observes.

### M8 — Quota enforcement

A decision point rather than a predetermined task. An over-quota user must
stop passing traffic, and Xray has no built-in quota block, so the choice
is between excluding them from the next render (consistent with every other
authorization decision, but restart-heavy and therefore scheduled) and
removing them at runtime through the Xray API (no restart, but it
introduces a second path to the same state, which is where drift bugs
live). Whichever is chosen, the config render stays the source of truth.
