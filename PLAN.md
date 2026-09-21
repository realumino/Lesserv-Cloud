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

## Current status: M5 complete — a two-node fleet and the real admin UI

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

Post-M4 cleanup — **workerd is the only runtime.** The local uvicorn
entrypoint (`src/local.py`), the SQLite backend (`SqliteConn`), the
in-app migration runner (`src/migrations.py`), and `key_cipher`'s
plaintext fallback are deleted; `uvicorn`/`httpx` are out of the dev
dependencies. Tests run in three tiers: `tests/pure/` (pure modules,
uv-venv interpreter, ~1s), `tests/workerd/` (a real plane on a throwaway
`--persist-to` D1, driven over HTTP with unique ids), and `frontend/`
(vitest over the SPA's pure logic, plus `tsc --noEmit` as the type gate).
The deleted SQLite/migration tests lost their subject; the remaining
service-level duplicates were folded into the HTTP tests. A static AST
test (`tests/pure/test_no_environment_compat.py`) fails the build if
`src/` ever imports `sqlite3`, `uvicorn`, or module-scope `js`/`workers`
again. The cross-repo agent E2E (`Lesserv-Agent`) launches the plane via
`pywrangler dev` the same way.

M5 made the fleet claim literal and replaced the placeholder SPA with the
actual admin interface. Adding node #2 required no `src/` change:
`tests/workerd/test_two_nodes.py` drives two fake agents through one plane
and proves independent renders (different qualified tags and REALITY keys),
independent apply/report (A settling leaves B drifted), that a user edit on
A leaves B's desired hash byte-identical, and that A's valid token is 401 on
every one of B's endpoints. `tests/workerd/test_admin_assets.py` pins the
serving arrangement: the shell at `/admin/`, a deep link served the shell to
a browser navigation, and an unknown non-navigation path still failing
closed. The frontend is React + React Router + Tailwind v4 under
`frontend/`, built by Vite at `base: '/admin/'`, type-gated by
`tsc --noEmit`, and unit-tested with vitest over its pure logic (the
authoritative access-form mapping, formatting, the fleet row join). Every
page is a real URL, including the done-when's `/admin/nodes/tokyo01/config`;
the user form edits access as per-node sections with local tags only, so the
admin never types a qualified name, and the node detail page manages config,
keys, users, and per-inbound link profiles. The API is unchanged,
`PROTOCOL.md` stays frozen at `protocol: 1`, and Cloudflare Access still
guards the whole surface. One operator item remains: pointing a second
machine's agent at the deployed plane (deferred, like M4's VPS step). The
executable plan and its decisions live in
[`docs/M5-PLAN.md`](docs/M5-PLAN.md).

The TypeScript rewrite replaced the Python plane (FastAPI on Pyodide) with
TypeScript on workerd — Hono + Zod + `@noble/curves`, the same routes,
database, and byte-for-byte output. The port was a language change, not a
redesign: every locked decision in `AGENTS.md` survives, `docs/PROTOCOL.md`
and `migrations/*.sql` are untouched, and the frontend never noticed. The
suite is one command (`npm test`: 216 tests executed inside workerd); the
Python tree, its tests, and its tooling are deleted. Byte parity was gated
by a hash audit that rendered a seeded D1 with both implementations, in
both key-generation directions: every parity node's `desired_hash`, render,
cross-plane token, and share-link body matched, while the two documented
divergence classes (whole-number floats and oversized integers in stored
config text) were reproduced as negative controls rather than assumed
absent. Measured locally, the rewrite cuts the deploy bundle from
8,731.64 KiB (2,171.40 KiB gzip) to 970.56 KiB (168.91 KiB gzip) and
dev boot-to-health from 8.5s to 1.5s; deployed CPU-time and cold-start
numbers do not exist yet because nothing is deployed — the account is
currently empty and the staging/production deploy is the remaining
operator step. The executable record, including that deviation, lives in
[`docs/TS-REWRITE-PLAN.md`](docs/TS-REWRITE-PLAN.md).

M6 gave every user a subscription: a rotatable, plaintext `sub_token`
minted at user creation (32 random bytes, base64url, stored under a unique
index), and `GET /sub/{token}` — served under the M4 Access bypass —
returning standard base64 of the newline-joined URIs across every node the
user is entitled to, each link carrying its own node's address. The body is
the admin links endpoint's list encoded: the cross-node aggregation moved
out of the router into `link_service.userLinks` so both presentations are
one walk (`tests/workerd/admin_users.test.ts` held green through the move
with zero edits). Unknown, rotated-out, disabled, expired, and
nothing-configured tokens all answer `200` with an empty body — a
capability URL never distinguishes "no such user" from "not entitled" —
and `expire: 0` means never, matching the UI convention. 236 tests pass
inside workerd; the SPA gained a `SubscriptionCard` (URL, copy, QR,
rotate/generate) in the share dialog and the user edit page. The live
smoke — mint, serve, rotate, disable, unknown-token, fail-closed route
shape — ran against a local plane. The operator-run acceptance item is
importing a real subscription URL into a client app against the deployed
plane, like M4/M5's deferred machine steps. The executable plan and its
decisions live in [`docs/M6-PLAN.md`](docs/M6-PLAN.md).

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Spike: platform viability | done |
| 1 | Scaffold + node-scoped data model (one node, SQLite) | done |
| 2 | Qualifier + link profiles | done |
| 3 | The agent, split out (systemd, pull over localhost) | done |
| 4 | Control plane on Workers + D1 | done (agent-on-VPS run = operator step) |
| 5 | Node #2 + the new frontend | done (second-machine run = operator step) |
| TS | Port the plane from Python to TypeScript on workerd | done (deploy = operator step) |
| 6 | Subscriptions | done (real-client import = operator step) |
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

Complete: the two-node proof is `tests/workerd/test_two_nodes.py`, the
serving arrangement is pinned by `tests/workerd/test_admin_assets.py`, and
the SPA is React + React Router + Tailwind v4 with a router and vitest pure
tests. Link profiles gained minimal CRUD on the node detail page. The one
remaining acceptance item is operator-run: install the agent on a second
machine and watch both nodes converge in the deployed fleet view. The
executable record is in [`docs/M5-PLAN.md`](docs/M5-PLAN.md).

### M6 — Subscriptions

Done when: a user has a rotatable `sub_token`; `/sub/{token}` returns the
base64 newline-joined list of every link the user is entitled to, across
every node, with each link carrying its own node's address; disabled or
expired users get an empty body rather than an error; and adding node #2
enriches an existing subscription URL without changing it.

Complete: the token is plaintext `users.sub_token` (minted at user
creation, rotated by `POST /api/admin/users/{u}/sub-token`), the endpoint
is `src/routers/sub.ts` over `subscription_service`, and the aggregation is
shared with the admin links route via `link_service.userLinks` — the body
is that endpoint's list, base64-encoded. Entitlement (`isEntitled`) treats
`expire` null or 0 as never; every not-entitled state, including an unknown
token, is a `200` empty body with `no-store`. The SPA shows the URL, copy,
QR, and rotation on a `SubscriptionCard` in the share dialog and the user
edit page. Proof: `tests/workerd/subscriptions.test.ts` (all seven criteria
in `docs/M6-PLAN.md`) plus the untouched admin-links tests; the live local
smoke passed end to end. The operator-run item is importing a real
subscription URL into a client app against the deployed plane.

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
