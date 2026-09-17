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
src/main.py      create_app() — routes only, imports nothing platform-specific
src/local.py     imports app, attaches SQLite to app.state, serves via uvicorn
src/worker.py    imports app, serves via workers.asgi (D1 arrives on the request scope)
```

The piece that makes one app serve both backends is the **conn
interface**: `await conn.execute(sql, params) -> list[dict]`. Locally,
`SqliteConn` wraps `sqlite3` (and commits, so tests see writes). On
Workers, `D1Conn` wraps the D1 binding. Both live in `db.py`, and a
request-scoped dependency (`db.get_conn`) picks one — from `app.state`
locally, from `request.scope["env"].DB` inside workerd. Routers and
services are identical in both runtimes; `tests/test_app.py` boots the
Worker app under TestClient with the SQLite backend and would catch any
drift.

The import root is `src/` (the directory workerd treats as the module
root), so application imports are flat: `from core.x25519 import ...`.
uvicorn matches it with `--app-dir src`; tests get the same root from the
shim in `tests/__init__.py`. The spike evidence behind these shapes —
including the no-entropy-at-import rule for the deploy snapshot — is in
`docs/M0-FINDINGS.md`.

## The render pipeline

This is the heart of the control plane. Everything else exists to feed it
or to move its output.

For one node, the pipeline is four steps in a fixed order:

```
node.config_json   (authored, identity-free: "reality", "niigata")
      │
      │  qualify_config(config, node.id)
      ▼
qualified config    (reality-tokyo01, tokyo01-niigata, BLOCK untouched)

user_node_access rows for that node
      │  qualify_users(rows, node.id)      → inbound/outbound lists and
      ▼                                       uuid keys get the same names
reality_keys rows for that node
      │  qualify_keys(keys, node.id)       → keyed by qualified tag
      ▼
      ├──────────────────────────┐
      │  build_config            │  unchanged pure core: fills clients,
      │  apply_reality_keys      │  appends routing rules, injects keys
      └──────────────────────────┘
      ▼
rendered runtime config  →  sha256  →  served to that node's agent
```

Three properties matter more than the individual steps:

**Qualification happens on the inputs, not the output.** Because
`qualify_config` runs before `build_config`, the allocator sees qualified
tags and emits qualified emails and rules on its own. `build_config` and
`apply_reality_keys` are never touched — if they need editing to make
multi-node work, the qualifier is wrong.

**Nothing qualified is stored.** The database only ever holds local names
scoped by `(node_id, tag)`. The qualified form is a projection that exists
for the length of one render and inside generated share links. That is why
renaming a node id is one `UPDATE nodes` plus a re-render instead of a
migration across every config, policy row, and key.

**Rendering is pure and per-node.** Given a node row, its access rows, and
its keys, the output is a deterministic function of the inputs. That makes
it testable with plain dicts, exactly like the archived
`test_config_service.py`, and it means the plane can compute a node's
desired hash without any side effects.

## The qualifier

`qualify_service` is the only genuinely new pure logic in the control
plane compared to the archived panel. It is small, and it has one sharp
edge.

What it rewrites:

| Target | Rule | Example |
|---|---|---|
| `inbounds[].tag` | suffix | `reality` → `reality-tokyo01` |
| `outbounds[].tag` | prefix, **except BLOCK** | `niigata` → `tokyo01-niigata` |
| `routing.rules[].outboundTag` | prefix | `niigata` → `tokyo01-niigata` |
| `routing.rules[].inboundTag[]` | suffix | `xhttp` → `xhttp-tokyo01` |
| `routing.rules[].user[]` | rewrite `regexp:.*@TAG$` | `.*@niigata$` → `.*@tokyo01-niigata$` |
| access inbound lists | suffix | `["reality"]` → `["reality-tokyo01"]` |
| access outbound lists | prefix | `["niigata"]` → `["tokyo01-niigata"]` |
| uuid map keys | rewrite the part after `@` | `alice@niigata` → `alice@tokyo01-niigata` |
| reality key map keys | suffix | `{"reality": k}` → `{"reality-tokyo01": k}` |

The sharp edge is the routing rules. `build_config` appends the generated
rules *after* the admin's own, so any user-authored rule that references a
tag must be rewritten too, or it will point at a tag that no longer exists.
That is why the table above includes `outboundTag`, `inboundTag`, and the
`user` matcher. The known gap is `routing.balancers[].selector`: balancers
are rare, and an admin who uses one should write qualified names by hand.

Two guardrails: qualification must be **idempotent** (applying it twice is
harmless), and inbound tags must be validated as plain local names at paste
time, so an admin who types `reality-tokyo01` into an authored config gets
told rather than getting `reality-tokyo01-tokyo01` at runtime.

BLOCK is exempt in every direction. It is not a routable exit — it is the
first outbound, which Xray falls back to when no rule matches — so it never
participates in the naming scheme or in generated rules.

## The data model

D1 tables, and what each one is for. The `node` dimension appears on every
table that describes something belonging to a specific machine.

| Table | Key | Purpose |
|---|---|---|
| `nodes` | `id` (`tokyo01`) | identity, label, public `address`, token hash, the authored `config_json`, applied hash, last-seen, health, versions, last error |
| `reality_keys` | `(node_id, inbound_tag)` | panel-generated X25519 private keys, encrypted at rest; one per REALITY inbound, many allowed per node |
| `user_node_access` | `(username, node_id)` | node membership plus `allowed_inbounds`, `allowed_outbounds`, and the `uuids` map keyed by local outbound |
| `link_profiles` | `id` | per-inbound client-side variants (CDN and similar): name plus address/SNI/host/path overrides |
| `users` | `username` | global identity: status, expiry, note, subscription token |
| `config_versions` | `id` | history of rendered configs per node, for diff and rollback |
| `node_stats` | `(node_id, email)` | traffic counters (milestone 7) |
| `audit_log` | `id` | who changed what, with the actor taken from the Access JWT |

Notes worth keeping in mind:

- **`user_node_access` is the Option B model.** Membership is a stored row
  rather than something inferred from whether a user's tag strings happen
  to exist in some node's config. This is what makes "who can use node X?"
  a query instead of a scan, and what makes "an inbound from tokyo01 with
  an exit from almaty02" unrepresentable rather than merely wrong.
- **Two independent lists, no pairing.** Inbound and outbound allowed-sets
  are crossed by the allocator, exactly as before. A user allowed on a node
  with inbounds but no outbounds simply produces nothing there.
- **`uuids` is keyed by local outbound** (`{"niigata": "..."}`), scoped by
  the row's node. The allocator still looks up `username@tag`, so the
  qualifier builds that lookup key at render time. Stability is preserved:
  adding an outbound mints one new uuid and leaves the rest alone.
- **JSON text columns are fine** at this scale, same reasoning as the
  archived panel: optimize when it hurts.

## Trust boundaries

There are exactly four kinds of caller, and each has its own mechanism.

| Prefix | Caller | Identity | Mechanism |
|---|---|---|---|
| `/api/admin/*` | human | admin email | Cloudflare Access session |
| `/api/node/*` | agent | node id | bearer token, SHA-256 hash in `nodes` |
| `/sub/*` | end user | the user | capability token in the URL |
| `/api/health` | anyone | none | — |

**Admin.** Cloudflare Access protects the hostname with a default-deny
policy, plus bypass policies for the three public paths. Default-deny is
chosen deliberately: a new admin route that someone forgets to protect is
still protected, and a typo in a bypass path fails closed (it breaks the
public thing rather than exposing the private one). The Worker receives a
signed `Cf-Access-Jwt-Assertion` and uses its email as the audit actor.
The header is only meaningful on a path Access actually covers — on an
uncovered path it is attacker-controlled, which is one more reason the
route groups must be exhaustive and closed.

**Node.** 32 random bytes, base64url, shown once at creation and stored
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

The control plane generates every REALITY private key and stores it in D1,
encrypted with AES-256-GCM using a key held in a Worker secret. The
ciphertext is stored with a scheme prefix and its IV, so the format can be
rotated later without a migration:

```
v1:<base64(iv || ciphertext+tag)>
```

Only `reality_keys.private_key` is encrypted. User UUIDs and node configs
are far less sensitive, and encrypting everything would make every query
worse for no real gain. Node tokens are a third thing again: hashed, not
encrypted, because they are never read back.

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

The `1 +` is the direct view, derived from the inbound's `streamSettings`
plus the node's `address`. Extra profiles are rows in `link_profiles`, and
they are per-inbound because they describe a client-side view of that
inbound — CDN fronting only makes sense for HTTP transports, so `xhttp`
can have a `cdn` profile and `reality` cannot. Because the stored profile
is an override and the direct view is derived, a profile can never drift
out of sync with the inbound it describes.

Labels are readable: `Tokyo 01 · REALITY → Niigata`. The pieces come from
stored labels for nodes and profiles, and prettified names for local tags.
Nothing stores a display name for a tag inside the opaque config, because
that is state that rots the moment the pasted JSON changes. Since labels
are cosmetic, renaming one never breaks a client — only a UUID change or a
key rotation does.

A **subscription** is the aggregation: `/sub/{token}` returns base64 of
newline-joined URIs, covering every node the user is entitled to, each link
carrying its own node's address. This is where the fleet model pays off for
the user — granting access to a second node enriches an existing URL
without the URL changing. A disabled or expired user gets an empty body
rather than an error: their links are already gone from the server side,
and an empty response tells the client nothing new.

## Life of a change: the admin edits a user

1. The admin saves the user form. Access has already authenticated them,
   and the JWT's email will become the audit actor.
2. The router validates the payload and calls the user service, which
   writes `users` and the `user_node_access` rows and runs `ensure_uuids`
   per node — existing pairs keep their UUID, new pairs get one.
3. Nothing is pushed. There is no fan-out, because there is nothing to
   fan out: the plane does not track a version per node.
4. On each node's next heartbeat, the plane renders that node's desired
   state, hashes it, and compares it to the hash the node reported. A node
   whose authorized user set changed now has a different hash.
5. That node's agent fetches the new config, tests it, snapshots the old
   one, swaps it in, restarts Xray, and reports the applied hash.
6. The fleet view stops showing that node as drifted.

The important property: **step 3 is empty.** Content-hash convergence means
a user edit does not have to know which nodes are affected, which is what
removes an entire class of ordering and fan-out bugs.

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

Heartbeats must be cheap. The plane does not write `last_seen` on every
poll — only when it has moved meaningfully — because at fleet scale that
is hundreds of writes a minute for no information gain.

## Traffic stats

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
- **Why the async/sync split.** Pure computation has no I/O and stays
  synchronous and trivially testable. D1 has no synchronous API, so
  everything touching it is `async`. That line is the convention.

## Conventions

Same as `AGENTS.md` — this is binding: docstrings explaining what and why,
functions under ~30 lines with one job, plain dicts and lists, minimal
dependencies, and this file updated in the same commit as the code.
