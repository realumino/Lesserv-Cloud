# ARCHITECTURE.md — how Lesserv-Cloud works, explained

A human-readable walkthrough: what each piece does, how the pieces fit
together, and what happens when something changes.

**Maintenance rule: this file is updated in the same commit that changes
the code.** When a behavior changes, fix the section that describes it.
Treat it like code — wrong documentation is worse than none.

## What Lesserv is

A control plane for a fleet of VLESS/Xray nodes. One panel manages N
independent servers: it stores each node's config, decides who may use
which node and which exit, renders each node's runtime config, and hands
that to an agent running on the node.

The nodes are deliberately **not** a mesh. They never talk to each other,
there is no node-to-node routing, and an "exit" is an external endpoint
(a WireGuard peer, a Shadowsocks server, a VLESS server) that the panel
does not manage. `tokyo01-niigata` and `toyama01-niigata` may point at the
same physical machine and are still completely independent objects.

The differentiator inherited from the archived single-node panel: a user's
Xray client email is `username@outboundtag`, and routing rules match it
with `regexp:.*@outboundtag$`. One rule per exit, per-user exit selection,
no rule per user. In a fleet, the tag carries the node id, so the email
`alice@tokyo01-niigata` is globally unambiguous — and that is also what
makes traffic accounting attributable later.

## The three repos

- **Lesserv-Cloud** (this repo) — the control plane: Worker, D1, frontend,
  the render pipeline, the protocol server.
- **Lesserv-Agent** — the node software: pull, apply, restart, report. It
  contains no policy and no rendering. Its own repo because node software
  and a Worker cannot share a release cadence: rolling an agent across
  nodes is deliberate, versioned work.
- **Lesserv** — the archived single-node panel. Reference only; nothing
  imports from it. Its value now is its `ARCHITECTURE.md` and its tests.

These are separate repos for a concrete reason, not tidiness: the two
deployables share **no code**. Because the control plane renders, the
allocator, the X25519 implementation, the config filler, the share-link
builder, and the data model are all plane-side. The agent receives a
finished JSON document. The only thing crossing the boundary is the
protocol, which is why `docs/PROTOCOL.md` exists and carries a version.

## The layers

```
Browser (TS SPA at /admin, built by Vite, served as static assets)
   │  fetch /api/admin/*        (Cloudflare Access session)
   ▼
Worker (Python, FastAPI)
   │
   ├── routers/*        HTTP concerns only: paths, status codes, JSON
   ├── services/*       business rules (render, qualify, reality, share)
   ├── core/*           pure computation, no I/O (allocator, x25519)
   └── db.py            the only file containing SQL
   │
   ▼
D1 (SQLite, at the edge, single primary for writes)

   and separately, reaching in from outside:

Agent (Lesserv-Agent, on each node)
   │  POST /api/node/*   (bearer token, node-scoped)
   ▼
Worker → rendered config → agent writes it, restarts Xray, reports back
```

Two rules keep this healthy, both inherited from the archived panel:
requests flow **down only** (router → service → db, never reverse), and a
module never knows about the layer above it. `db.py` has no idea HTTP
exists; routers have no idea SQL exists.

## Two entrypoints, one app

The same `app` object (`src/main.py`) runs in two places, and that is a
tested property, not an aspiration:

```
src/main.py      create_app() — routes, the route-group guard, nothing platform-specific
src/local.py     imports app, attaches SQLite to app.state, serves via uvicorn
src/worker.py    imports app, serves via workers.asgi (D1 arrives on the request scope)
```

The piece that makes one app serve both backends is the **conn
interface**: `await conn.execute(sql, params) -> list[dict]`. Locally,
`SqliteConn` wraps `sqlite3` (and commits, so tests see writes). On
Workers, `D1Conn` wraps the D1 binding. Both live in `db.py`, and a
request-scoped dependency (`routers/deps.py:conn`) picks one — from
`app.state` locally, from `request.scope["env"].DB` inside workerd. The
dependency lives in `routers/` and not `db.py` on purpose: FastAPI only
recognizes a `Request` parameter through its type annotation, and that
annotation is HTTP knowledge, which `db.py` must not have. Routers and
services are identical in both runtimes; `tests/test_app.py` boots the
app under TestClient with the SQLite backend and would catch any drift.

The schema comes from `migrations/*.sql` — the single source of truth for
both backends. Locally, `local.py`'s lifespan applies them through
`migrations.py` (a tiny runner that records applied filenames in a
`schema_migrations` table); on Workers, wrangler applies the same files
(`d1 migrations apply`), which is why the M4 proof that migrations land
cleanly on a fresh D1 was applying the same files, not a rewrite
(runbook and evidence in `docs/DEPLOY.md`).

The import root is `src/` (the directory workerd treats as the module
root), so application imports are flat: `from core.x25519 import ...`.
uvicorn matches it with `--app-dir src`; tests get the same root from the
shim in `tests/__init__.py`. One extra rule found by the deploy-snapshot
test: `local.py` imports `uvicorn` lazily inside its `main()` — uvicorn
drags in `multiprocessing`, whose import draws entropy, and every module
that ships must import cleanly with a poisoned PRNG (see
`tests/test_import_hygiene.py`, which runs the poison import in a
subprocess). The spike evidence behind these shapes is in
`docs/M0-FINDINGS.md`.

## The render pipeline

This is the heart of the control plane. Everything else exists to feed it
or to move its output.

For one node, the pipeline is (M2, with the qualifier):

```
nodes.config_json   (authored, opaque, local tags: "reality", "niigata")
      │
      │  render_service.node_users(conn, node_id)
      ▼
projected users     archived user shape: uuids re-keyed from
      │             {"niigata": u} to {"alice@niigata": u},
      │             status passed through, sorted by username
      │
reality_service.ensure_keys(conn, node_id, config)
      │             generates and stores a key per missing REALITY tag,
      │             indexed by local inbound tag
      │
qualify_service.qualify_config / qualify_users / qualify_keys
      │             local inputs become node-qualified inputs; storage is unchanged
      ▼
      ├──────────────────────────┐
      │  build_config            │  copied pure core, untouched:
      │  apply_reality_keys      │  fills clients, appends routing
      │                          │  rules, injects keys
      └──────────────────────────┘
       ▼
rendered runtime config  →  config_hash (canonical JSON, sha256)
                         →  served to the node's agent on pull (M3)
```

Three properties matter more than the individual steps:

**The projection is the seam, the pure core never changes.**
`render_service.user_shape` rebuilds the archived user dict — storage
keys uuids by local outbound tag, the allocator wants
`username@outboundtag` emails — and `build_config`/`apply_reality_keys`
arrive from the archived panel byte-for-byte except for one import line.
M2's qualifier rewrites the projection and the config's tags; if the
pure core ever needs editing to make multi-node work, the qualifier is
wrong.

**Rendering is per node and deterministic.** Given a node row, its
access rows, and its keys, the output is a deterministic function of the
inputs — projections are sorted (users by username, nodes by id) so the
same database state renders byte-identical output, which is what
`config_hash` (canonical JSON, sorted keys) depends on. `desired_config`
returns `(None, [])` for a node without a config and `(None, [warning])`
for a malformed one: the render never raises, exactly like the archived
sync warned and skipped.

**Key generation has one choke point.** `ensure_keys` runs inside
`desired_config`, so every path that renders a config — a save, a
rotation, a future agent fetch — guarantees a stored key per REALITY
inbound before anything is served. That is the archived panel's
reasoning, now scoped to a node.

## The qualifier (M2)

`qualify_service` is the pure logic that turns local stored names into
node-scoped render and link names. Storage still uses local tags; rendered
emails are qualified because every render now carries a node identity.
`qualify_config`, `qualify_users`, and `qualify_keys` sit between key
generation and the unchanged pure render core, while `qualify_profiles`
groups stored profiles under qualified inbounds for link generation.

What it rewrites:

| Target | Rule | Example |
|---|---|---|
| `inbounds[].tag` | suffix | `reality` → `reality-tokyo01` |
| `outbounds[].tag` | prefix, **except BLOCK** | `niigata` → `tokyo01-niigata` |
| `routing.rules[].outboundTag` | prefix, **except BLOCK** | `niigata` → `tokyo01-niigata` |
| `routing.rules[].inboundTag[]` | suffix | `xhttp` → `xhttp-tokyo01` |
| `routing.rules[].user[]` | rewrite a trailing `@TAG`, literal or `regexp:` | `.*@niigata$` → `.*@tokyo01-niigata$` |
| access inbound lists | suffix | `["reality"]` → `["reality-tokyo01"]` |
| access outbound lists | prefix | `["niigata"]` → `["tokyo01-niigata"]` |
| uuid map keys | rewrite the part after `@` | `alice@niigata` → `alice@tokyo01-niigata` |
| reality key map keys | suffix | `{"reality": k}` → `{"reality-tokyo01": k}` |

The sharp edge is the routing rules. `build_config` appends the generated
rules *after* the admin's own, so any user-authored rule that references a
tag must be rewritten too, or it will point at a tag that no longer exists.
That is why the table above includes `outboundTag`, `inboundTag`, and the
`user` matcher. The known gaps are `routing.balancers[].selector` and
chained `outbounds[].proxySettings.tag` references: balancers and proxy
chains are rare, and an admin who uses them should write qualified names
by hand.

Two guardrails: qualification must be **idempotent** (applying it twice is
harmless), and inbound tags must be validated as plain local names at paste
time, so an admin who types `reality-tokyo01` into an authored config gets
told rather than getting `reality-tokyo01-tokyo01` at runtime.

BLOCK is exempt in every direction. It is not a routable exit — it is the
first outbound, which Xray falls back to when no rule matches — so it never
participates in the naming scheme or in generated rules.

## The data model

The tables below start from M1 (schema in `migrations/0001_init.sql`) and
include the M2 addition (`migrations/0002_link_profiles.sql`). The `node`
dimension appears on every table
that describes something belonging to a specific machine.

| Table | Key | Status | Purpose |
|---|---|---|---|
| `nodes` | `id` (`tokyo01`) | M1 | identity, label, public `address`, the authored `config_json`, token hash, applied hash, last-seen, health, versions, last error |
| `user_node_access` | `(username, node_id)` | M1 | node membership plus `allowed_inbounds`, `allowed_outbounds`, and the `uuids` map keyed by local outbound |
| `reality_keys` | `(node_id, inbound_tag)` | M1 | panel-generated X25519 private keys; one per REALITY inbound, many allowed per node |
| `users` | `username` | M1 | global identity: status, expiry, note |
| `link_profiles` | `(node_id, id)` | M2 | per-inbound client-side variants (CDN and similar) |
| `config_versions` | `id` | later | history of rendered configs per node, for diff and rollback |
| `node_stats` | `(node_id, email)` | M7 | traffic counters |
| `audit_log` | `id` | later | who changed what, with the actor taken from a verified Access JWT (verification itself also deferred) |

Notes worth keeping in mind:

- **The config lives in the database, not in a file.** `nodes.config_json`
  stores the admin's pasted JSON verbatim — the plane never interprets it
  beyond tag-name validation at paste time. The rendered runtime config
  is computed on demand (heartbeat, config fetch, runtime pane, sync
  view) and never written to disk — the M1–M2 `data/runtime/{node_id}.json`
  files left with the stopgap.
- **Agent-facing columns were filled by M3.** `token_hash`,
  `applied_hash`, `last_seen`, `health`, `agent_version`, `xray_version`,
  `last_error` sat in `nodes` since M1 as part of the locked data model;
  the token mint plus the enroll/heartbeat/report endpoints write them.
  No M3 migration was needed — exactly as planned.
- **`user_node_access` is the Option B model.** Membership is a stored row
  rather than something inferred from whether a user's tag strings happen
  to exist in some node's config. This is what makes "who can use node X?"
  a query instead of a scan, and what makes "an inbound from tokyo01 with
  an exit from almaty02" unrepresentable rather than merely wrong.
- **Two independent lists, no pairing.** Inbound and outbound allowed-sets
  are crossed by the allocator, exactly as before. A user allowed on a
  node with inbounds but no outbounds simply produces nothing there.
- **`uuids` is keyed by local outbound** (`{"niigata": "..."}`), scoped by
  the row's node. The allocator looks up `username@tag`, so
  `render_service.user_shape` builds that lookup key at render time.
  Stability is preserved: adding an outbound mints one new uuid and leaves
  the rest alone.
- **JSON text columns are fine** at this scale, same reasoning as the
  archived panel: optimize when it hurts. No foreign keys — deletes are
  explicit (`db.delete_user` removes access rows first).

## Trust boundaries

There are exactly four kinds of caller, and each has its own mechanism.

| Prefix | Caller | Identity | Mechanism |
|---|---|---|---|
| `/api/admin/*` | human | admin email | Cloudflare Access session |
| `/api/node/*` | agent | node id | bearer token, SHA-256 hash in `nodes` |
| `/sub/*` | end user | the user | capability token in the URL |
| `/api/health` | anyone | none | — |

**Admin.** Cloudflare Access protects the hostname with a default-deny
policy, plus bypass policies for the three public paths (live since M4;
the runbook is `docs/DEPLOY.md`). Default-deny is
chosen deliberately: a new admin route that someone forgets to protect is
still protected, and a typo in a bypass path fails closed (it breaks the
public thing rather than exposing the private one). The Worker receives a
signed `Cf-Access-Jwt-Assertion` and uses its email as the audit actor —
the JWT is not verified yet (no audit log to attribute), so treat the
header as untrusted until that milestone. The header is only meaningful
on a path Access actually covers — on an uncovered path it is
attacker-controlled, which is one more reason the route groups must be
exhaustive and closed.

**The in-app half of the boundary (since M1).** Cloudflare Access is live,
but the route-group rule is still enforced in the app: `main.py`
registers a middleware backed by `route_groups.is_allowed_path`, and any
request outside the four prefixes gets a bare 404 before routing — even a
route someone registers at the wrong prefix later. FastAPI's `/docs`,
`/redoc`, and `/openapi.json` are disabled for the same reason: they sit
at the root, outside every group, and the guard is fail-closed.

The admin **SPA** is a fifth, non-API surface: static assets served from
`frontend/dist` at `/admin/*` by Workers' asset layer, which runs *before*
the Worker, so those paths never reach the route guard — that is why the
guard's four-prefix invariant survives the SPA. The assets sit behind the
same Access application, and `/` is covered by it too (an Access bypass
for path `/` would match every path, so the root is protected rather than
public — see `docs/DEPLOY.md`). The app in the repo is a placeholder
until M5 rebuilds it.

**Node.** 32 random bytes, base64url, minted via
`POST /api/admin/nodes/{id}/token`, shown once at creation and stored
only as a hash. Hashed rather than encrypted for the same reason API keys
are hashed generally: it is high-entropy random, so it cannot be brute
forced and never needs to be read back. Note this is the opposite of
password advice, and for a good reason — passwords are low-entropy, which
is what makes slow KDFs necessary. A node token is not a password.

Possession of a node token means fetching that node's rendered config,
which contains every authorized user's UUID and that node's REALITY
private key. It is effectively root on that node's secrets, so: HTTPS
only, never log the `Authorization` header, and rotate on suspicion.

**End user.** No identity, no login — clients can't do SSO. `/sub/{token}`
is a capability URL: whoever holds it is the user. That is the accepted
model in this ecosystem, so the design work is bounding the blast radius —
unguessable tokens, instant rotation, `Cache-Control: no-store`, and a body
that contains nothing but the links.

## Key custody

The control plane generates every REALITY private key and stores it in
the database. The storage is AES-256-GCM ciphertext with a key held in a
Worker secret (`REALITY_KEY_SECRET`), live since M4:

```
v1:<base64(iv || ciphertext+tag)>
```

The scheme prefix and its IV mean the format can rotate later without a
migration, and every stored value is self-contained. `crypto.py` speaks
WebCrypto, which only exists inside workerd, so sealing happens through
`services/key_cipher.py`: inside workerd, `seal` encrypts with the secret
and `unseal` decrypts; under CPython (local uvicorn, tests) there is no
secret and no cipher, so the same functions store and read plaintext.
The `v1:` prefix is the discriminator, which is why pre-M4 plaintext
rows keep reading and no migration was needed to introduce the format.
M4's deploy therefore starts from a fresh D1 where every generated key
is ciphertext from the first day.

Only `reality_keys.private_key` is encrypted. User UUIDs and node
configs are far less sensitive, and encrypting everything would make every
query worse for no real gain. Node tokens are a third thing again: hashed,
not encrypted, because they are never read back.

Two invariants:

- **A private key never leaves the process.** Public keys are derived on
  demand with the pure X25519 implementation and are the only key material
  the API returns. The panel already worked this way; keep it.
- **Encryption at rest is a seatbelt, not a wall.** It protects against a
  database dump. It does not protect against someone who also has the
  Worker's secrets. That is the correct trade, but it should be understood
  rather than assumed.

Key rotation is manual and explicit. Since a rotation invalidates every
link that used the old key, it is an operator action with a confirmation,
never an automatic side effect of a render.

## Links, link profiles, and subscriptions

A **link** is one `vless://` URI: one inbound on one node, one exit, one
uuid. The number of links a user has on a node is:

```
Σ over allowed exits ( Σ over allowed inbounds ( 1 + extra link profiles ) )
```

Each profile attached to an inbound adds one URI per allowed exit; the
direct URI remains first.

The direct view is derived from the inbound's `streamSettings` plus the
node's `address` — `nodes.address` replaced the archived panel's global
`SERVER_ADDRESS`, so two nodes produce different URIs for the same user
and no environment variable is involved. Extra profiles are rows in
`link_profiles`, per-inbound because they describe a client-side view of
that inbound — CDN fronting only makes sense for HTTP transports, so
`xhttp` could have a `cdn` profile and `reality` cannot. Profile writes
never render, sync, or restart: they affect only generated links.

Since M1, the links endpoint (`GET /api/admin/users/{u}/links`)
aggregates across every node the user has an access row on: each link
carries its `node`, warnings are prefixed with the node id, and a node
without a config is skipped with a warning rather than failing the whole
request. Since M2, link fields use qualified names and every link carries
a readable `label` and optional `profile`. The archived status codes
survive: 404 unknown user, 503 when
the user has access but no node has a config, 409 when no node has a
usable address.

Labels are readable: `Tokyo 01 · REALITY → Niigata`. The pieces come from
stored labels for nodes and profiles, and prettified names for local tags.
Nothing stores a display name for a tag inside the opaque config, because
that is state that rots the moment the pasted JSON changes. Since labels
are cosmetic, renaming one never breaks a client — only a UUID change or a
key rotation does. The same naming helper feeds any future UI, including M5.

A **subscription** is the aggregation (M6): `/sub/{token}` returns base64
of newline-joined URIs, covering every node the user is entitled to, each
link carrying its own node's address. This is where the fleet model pays
off for the user — granting access to a second node enriches an existing
URL without the URL changing. A disabled or expired user gets an empty
body rather than an error: their links are already gone from the server
side, and an empty response tells the client nothing new.

## Life of a change: the admin edits a user

1. The admin saves the user form. (Cloudflare Access authenticates the
   request since M4; locally, the dev machine's localhost is the boundary.)
2. The router validates the payload and calls the user service, which
   writes `users` and the `user_node_access` rows and runs `ensure_uuids`
   per node — existing pairs keep their UUID, new pairs get one.
3. Nothing is pushed. There is no fan-out, because there is nothing to
   fan out: the plane does not track a version per node.
4. On each node's next heartbeat, the plane renders that node's
   desired state, hashes it (`config_hash` — included and tested since
   M1), and compares it to the hash the node reported. A node whose
   authorized user set changed now has a different hash.
5. That node's agent fetches the new config, tests it, snapshots
   the old one, swaps it in, restarts Xray, and reports the applied hash.
   The fleet view stops showing that node as drifted.

The important property: **step 3 is empty.** Content-hash convergence means
a user edit does not have to know which nodes are affected, which is what
removes an entire class of ordering and fan-out bugs.

```
agent → POST /api/node/heartbeat
        X-Lesserv-Node: tokyo01      + bearer token
        {protocol: 1, applied_hash: "ab12…", xray_running: true, …}

plane → looks up the node by id, compares the token hash,
        renders the node's desired config, hashes it,
        returns {desired_hash: "cd34…", actions: []}

agent → hashes differ → GET /api/node/config?hash=cd34… → applies → reports
```

## Life of a heartbeat

```
agent → POST /api/node/heartbeat
        X-Lesserv-Node: tokyo01      + bearer token
        {protocol: 1, applied_hash: "ab12…", xray_running: true, …}

plane → looks up the node by id, compares the token hash,
        renders the node's desired config, hashes it,
        returns {desired_hash: "cd34…", actions: []}

agent → hashes differ → GET /api/node/config?hash=cd34… → applies → reports
```

Heartbeats are cheap. The plane does not write `last_seen` on every
poll — only when liveness went stale (>60s) or a reported fact changed —
because at fleet scale that is hundreds of writes a minute for no
information gain. The agent and these endpoints landed in M3; the columns
they fill (`nodes.token_hash`, `applied_hash`, `last_seen`, ...) have been
in the schema since M1.

## Traffic stats (from M7)

Traffic counters come from Xray's own stats API, which keys them by client
email: `user>>>alice@tokyo01-niigata>>>traffic>>>uplink`. This is the
second payoff of qualified tags — with local tags, every node's counters
would collide on `alice@niigata` and attribution would require trusting
which agent reported.

Two mechanics that are painful to retrofit, so they are designed in from
the start:

- **Counters are absolute, not deltas.** The agent reports absolute values
  plus a boot identifier; the plane stores the last-seen value per
  (node, email) and accumulates `max(0, new - old)`, treating a decrease or
  a changed boot id as a restart. Deltas computed on the node are not
  idempotent when a report is retried — the plane's accumulation is.
- **Xray restarts reset counters.** Restarts are routine here, so this
  happens constantly; the reset detection above is not an edge case.

The rendered config must guarantee the `api`, `stats`, and `policy`
sections exist and are correct. This is the panel's **fifth owned place**,
after routing rules, VLESS clients, REALITY private keys, and outbound
order — the same discipline applies: ensure what the panel needs, and
leave everything else in the config untouched.

## Concepts that were confusing (and their answers)

- **Why the runtime config has different names from the stored config.**
  The stored config is authored once and could be cloned onto a second
  node verbatim; identity enters at render. The admin sees both panes.
- **Why a node token is hashed and not encrypted.** It is 256 bits of
  random, so it cannot be brute-forced and never needs to be read back.
  Passwords are the opposite problem and need slow KDFs.
- **Why there is no version counter.** A version counter needs every writer
  to know which nodes to bump. A content hash is computed from the inputs,
  so there is nothing to keep in sync.
- **Why the biggest-possible-config isn't always best.** Every extra link
  profile multiplies the link list; the `1 + extras` rule keeps the direct
  view free and charges only for what is actually added.
- **Why `db.py` is still one file.** It is the only file containing SQL, so
  the D1 port changed function bodies and nothing else.
- **Why `xray_service` is gone when the code once managed Xray.** It was
  the M1–M2 stopgap: through M2 the control plane was still one process
  ("still one process" in the milestone), so the archived panel's
  file-write + subprocess shell survived in a deliberately thin form.
  Rendering lived in `render_service`, so M3 deleted the shell and the
  sync calls without touching the pipeline — `settings.py` went with it.
- **Why the async/sync split.** Pure computation has no I/O and stays
  synchronous and trivially testable. D1 has no synchronous API, so
  everything touching it is `async`. That line is the convention.

## Conventions

Same as `AGENTS.md` — this is binding: docstrings explaining what and why,
functions under ~30 lines with one job, plain dicts and lists, minimal
dependencies, and this file updated in the same commit as the code.
