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

The plane is TypeScript on workerd: Hono + Zod + `@noble/curves`, Vitest
inside the same runtime, no bridge of any kind. It was ported from the
Python plane (FastAPI on Pyodide) in 2026; the execution record is
`docs/TS-REWRITE-PLAN.md`. Two modules exist only for byte parity and are
load-bearing, not cleanup targets: `src/core/python_json.ts` backs
`config_hash` (the agent's convergence contract) and `src/core/python_uri.ts`
backs `vless://` share links.

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
npm install                                                    # root deps: Worker, tests, tooling
npm run dev                                                    # the Worker + local D1, no CF account needed
npx wrangler d1 migrations apply <d1-database-name> --local    # dev database schema
npx wrangler d1 migrations apply <d1-database-name> --remote   # production schema
npm test                                                       # the whole suite, inside workerd (~15s)
npm run test:watch                                             # the same suite on watch
npm run typecheck                                              # tsc --noEmit for src/ and tests/
npm run build                                                  # wrangler deploy --dry-run (the deploy gate)
npm run types                                                  # regenerate worker-configuration.d.ts

npm --prefix frontend install                                  # first time only
npm --prefix frontend run dev                                  # Vite dev server, proxies /api to the local plane (:8787)
npm --prefix frontend test                                     # frontend pure-logic tests (vitest, no DOM)
npm --prefix frontend run build                                # tsc --noEmit + vite build -> frontend/dist
```

The app runs **only** under workerd (`src/worker.ts`, the default export of
the Hono app built in `src/main.ts`); there is no second entrypoint, no
Node-compat path, and no `node:` imports. The build enforces that where the
Python static tests used to: `tsc --noEmit` type-gates, `npm test` executes
the code inside workerd itself, and `npm run build` bundles with wrangler.
Tests live in two tiers under one command: `tests/pure/` exercises modules
that compute objects (no bindings), and `tests/workerd/` drives the whole
Worker over `fetch()` against a real D1, with `migrations/*.sql` applied by
`readD1Migrations`/`applyD1Migrations` in the setup file.

Dev needs a `.dev.vars` with `REALITY_KEY_SECRET` (see `.dev.vars.example`)
— without it, every REALITY key endpoint fails loudly by design. The
wrangler config works the same way: the committed `wrangler.example.jsonc`
is the template, and the gitignored `wrangler.jsonc` that wrangler reads
is copied from it by the npm pre-hooks when missing (the placeholders are
fine for dev and tests; the copy gets the real values before a deploy).

Since M4 the deployed plane is the real thing: a Worker + D1 + Cloudflare
Access + static assets (hostname and resource ids are operator-specific and
kept out of this public repo). The deploy runbook — D1 migrations, the
`REALITY_KEY_SECRET` secret, the Access applications, and the post-deploy
smoke checks — lives in `docs/DEPLOY.md` and must be kept current by every
deploy that changes a step. Real values (hostname, D1 name/id) go in the
gitignored `wrangler.jsonc`, seeded from the committed
`wrangler.example.jsonc`, never in committed files.

The admin SPA lives under `frontend/` (React + React Router + Tailwind
v4, built by Vite with base `/admin/`) and is served from static assets;
`/api/admin/*` is the frozen interface it is built on, and its pages are
real routes (`/admin/nodes`, `/admin/nodes/:id/config`, ...). Its pure
logic is unit-tested with vitest; the API is not reimplemented there.
`frontend/dist/` is gitignored and produced by
`npm --prefix frontend run build`; `scripts/stub_frontend_dist.mjs` writes
stub indexes when it is absent, so a fresh clone can boot and deploy-check
without a SPA build. One entrypoint, one app: `src/worker.ts`. Imports
inside `src/` are relative paths (`../core/x25519`). Evidence and
constraints from the M0 spike: `docs/M0-FINDINGS.md` (Pyodide era,
historical).

## Conventions (user requirement — non-negotiable)

- Every function: a docstring explaining WHAT it does and WHY it exists
  (JSDoc-style blocks in TS, the ported Python docstrings' content).
- Functions under ~30 lines, one job each. Plain objects/arrays, no clever
  abstractions.
- Dependencies must be justifiable; keep them minimal — Hono, Zod, and
  `@noble/curves` are the whole runtime surface, and nothing else gets
  added without the same kind of reason.
- User reads every file before moving to the next milestone; explain code,
  don't just generate it.
- `ARCHITECTURE.md` is updated in the same commit as the code it describes.

## Gotchas

- **workerd is the only runtime.** `src/` must never grow `node:` imports,
  environment branches, or a second entrypoint. Anything that needs
  bindings, HTTP, or the database is tested black-box in `tests/workerd/`;
  whatever typechecks and bundles is what ships.
- **Pure is sync, I/O is async.** `core/` and the pure services
  (`qualify_service`, `config_service`, `share_service`) are ordinary
  synchronous functions — they compute objects. Anything touching D1 is
  `async` and must be awaited: D1 has no synchronous API, so every router
  and service that reads or writes is `async`. That asymmetry is the
  convention, not an accident. `config_hash` is async too, because
  WebCrypto's digest is the only SHA-256 in workerd.
- **`env` is passed, never global.** Bindings arrive on the Hono context
  (`c.env`); services that need them take `env` (or `env.DB`) as an
  argument. Nothing captures a binding at module scope.
- **No entropy at module scope.** Keep key generation and UUID minting
  inside request handlers; module-scope `crypto` calls are a Workers
  deploy hazard and a cached-per-isolate surprise.
- **Canonical JSON is not `JSON.stringify`.** `config_hash` hashes
  Python's `json.dumps(sort_keys=True, separators=(",", ":"))` byte for
  byte, which is why `src/core/python_json.ts` exists (ASCII escapes,
  code-point key order, float repr). Never "simplify" it to
  `JSON.stringify`: the hash is the agent's convergence contract, and a
  different hash makes every node re-apply. `python_uri.ts` is the same
  deal for share links.
- **WebCrypto wants buffers, not strings.** Encode with `TextEncoder`,
  pass `ArrayBuffer`/typed arrays, and keep base64/hex helpers in
  `crypto.ts` and `core/x25519.ts` rather than open-coding conversions at
  call sites.
- **Workers have no filesystem that persists, and no subprocess.** `db.ts`
  is the only file containing SQL, and it talks to D1 through the binding
  (the local `wrangler dev` D1 is real D1 semantics on disk). The
  archived panel's `xray_service.py` has no counterpart here — process
  management is entirely the agent's job.
- **Never store a qualified tag.** Tags are local and scoped by
  `(node_id, tag)`. If you find yourself writing `tokyo01-niigata` to the
  database, the design is being violated.
- **Never return a REALITY private key.** Derive the public key on demand;
  that is the only key material that may leave the process.
- **Route groups define the trust boundary**, and the boundary itself lives
  in Cloudflare Access, not in this code. `/api/admin/*` (Access),
  `/api/node/*` (node token), `/sub/*` (capability token), `/api/health`.
  Anything outside those four must 404 — fail closed, never fail open.
- **`worker-configuration.d.ts` is generated and committed.** After a
  binding or secret change, rerun `npm run types`; do not hand-edit it.
