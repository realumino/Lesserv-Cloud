# AGENTS.md — project context for Lesserv-Cloud

The control plane for a fleet of VLESS/Xray nodes. It owns the truth
(nodes, users, policy, REALITY keys), renders each node's runtime Xray
config, and serves it to agents that pull it. Companion repos:
`Lesserv-Agent` (node-side software) and `Lesserv` (the archived
single-node panel this replaces — reference only, not a dependency).

## Project state

Milestones and current status live in `PLAN.md`. The walkthrough (how each
module works, request flows, concepts) lives in `ARCHITECTURE.md` — update
it in the same commit that changes code; wrong documentation is worse than
none. The cross-repo contract with the agent lives in `docs/PROTOCOL.md`
and is versioned (`protocol: 1`).

## What this is

One control plane, N **independent** nodes. Nodes never talk to each
other. Exits (outbounds) are external endpoints — WireGuard, Shadowsocks,
or VLESS connections to machines the panel does **not** manage. There is no
node-to-node routing and no mesh: `tokyo01-niigata` and `toyama01-niigata`
are unrelated objects that happen to point at the same physical box.

The control plane's whole job in four sentences:

1. Store everything: each node's opaque Xray config, its users' per-node
   access, its REALITY keys.
2. Render a per-node runtime config: qualify tags, fill clients from the
   authorized users, generate routing rules from the email scheme, inject
   the panel-owned REALITY private keys.
3. Serve that rendered artifact to the node's agent, which applies it and
   reports back what it actually ran.
4. Show the difference between what a node runs and what it should run.

The differentiator carried over from the archived panel: a user's Xray
client email is `username@outboundtag` (`alice@tokyo01-niigata`) and
routing rules match it with `regexp:.*@tokyo01-niigata$`. Per-user exit
selection, one rule per exit, no rule per user.

## Architecture decisions (locked)

These were settled deliberately; do not relitigate them in passing.

- **Plane renders, agent applies.** The node receives a finished runtime
  config. No rendering, no policy, no allocator on the node.
- **Pull, not push.** The agent polls every 30s. NAT-proof, and it survives
  the control plane being down for a day.
- **Content-hash convergence.** A node is in sync when its reported
  `applied_hash` equals the hash of the config the plane would render now.
  There is no version counter to bump and no fan-out bookkeeping.
- **Identity-free authored config, qualified at render.** The stored config
  uses local tags (`reality`, `niigata`). The qualified form
  (`reality-tokyo01`, `tokyo01-niigata`) exists only in the rendered
  artifact and in generated share links. Nothing qualified is ever stored.
- **Option B access model.** `user_node_access(username, node_id, ...)`
  stores node membership and the two allow-lists. Membership is stored
  data, never inferred from tag strings. Inbound and outbound lists stay
  independent — no inbound×outbound pairing, exactly like the archived
  panel's allocator.
- **The plane owns REALITY keys**, keyed `(node_id, inbound_tag)`, any
  number per node, encrypted at rest, and only ever *derived* public keys
  leave the process.
- **Link profiles are per-inbound variants.** CDN fronting is a property of
  HTTP transports, so a profile attaches to one inbound. The direct view is
  derived from the inbound plus the node's address; only extras are stored.
- **Three auth tiers.** Admin = Cloudflare Access (default-deny with an
  explicit bypass list). Node = bearer token, hashed at rest, scoped to its
  own node. End user = capability token in a URL.
- **Stats come from Xray's gRPC API**, keyed by client email, which is why
  qualified emails matter. The agent ships the stats endpoint from v1; the
  dashboard and quota enforcement are separate milestones.

## Run it

```
uv run pywrangler dev                 # the Worker + local D1, no CF account needed
uvicorn src.main:app --reload         # the same app for local tests/dev (no D1)
python -m unittest discover tests -v  # tests
cd frontend && npm run dev            # frontend, proxies /api -> the Worker
wrangler d1 migrations apply lesserv --local    # dev database
wrangler d1 migrations apply lesserv --remote   # production
```

## Conventions (user requirement — non-negotiable)

- Every function: docstring explaining WHAT it does and WHY it exists.
- Functions under ~30 lines, one job each. Plain dicts/lists, no clever
  abstractions.
- Dependencies must be justifiable; keep them minimal.
- User reads every file before moving to the next milestone; explain code,
  don't just generate it.
- `ARCHITECTURE.md` is updated in the same commit as the code it describes.

## Gotchas

- **Pure is sync, I/O is async.** `core/` and the pure services
  (`qualify_service`, `config_service`, `share_service`) are ordinary
  synchronous Python — they compute dicts. Anything touching D1 is `async`
  and must be awaited: D1 has no synchronous API, so every router and
  service that reads or writes is `async def`. That asymmetry is the
  convention, not an accident.
- **Workers have no filesystem, no subprocess, and no `sqlite3` module.**
  `db.py` is the only file containing SQL, and it talks to D1 through
  bindings. The archived panel's `xray_service.py` has no counterpart here —
  process management is entirely the agent's job.
- **The same `app` object must run under both uvicorn and Workers.** If
  something only works in one of them, it's a bug in the app, not a
  platform quirk to work around.
- **Never store a qualified tag.** Tags are local and scoped by
  `(node_id, tag)`. If you find yourself writing `tokyo01-niigata` to the
  database, the design is being violated.
- **Never return a REALITY private key.** Derive the public key on demand;
  that is the only key material that may leave the process.
- **Route groups define the trust boundary**, and the boundary itself lives
  in Cloudflare Access, not in this code. `/api/admin/*` (Access),
  `/api/node/*` (node token), `/sub/*` (capability token), `/api/health`.
  Anything outside those four must 404 — fail closed, never fail open.
