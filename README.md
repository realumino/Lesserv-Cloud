# Lesserv-Cloud

The control plane for a fleet of VLESS/Xray nodes. It stores nodes, users,
per-node access, and REALITY keys; renders each node's runtime Xray config;
and serves it to the agent on that node, which applies it and reports back
what it actually ran.

It runs as a TypeScript Worker on workerd (Hono + Zod + `@noble/curves`)
with D1 as the store — one runtime, no Python bridge.

Nodes are independent — they never talk to each other, and exits are
external endpoints (WireGuard, Shadowsocks, VLESS) that the panel does not
manage.

## Documents

| File | What it holds |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Stable context: what this is, locked decisions, how to run it, conventions, gotchas |
| [`PLAN.md`](PLAN.md) | Volatile state: the milestone roadmap and current status |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The walkthrough: render pipeline, data model, trust boundaries, request flows |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | The cross-repo contract with `Lesserv-Agent` |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | The deploy runbook: D1, secret, Access applications, and post-deploy smoke checks |

## Develop

```powershell
npm install                      # root deps: Worker, tests, tooling
npm run dev                      # the plane + local D1 (needs a .dev.vars secret)
npm test                         # the whole suite, executed inside workerd
npm run typecheck                # tsc --noEmit for src/ and tests/
npm --prefix frontend install    # first time only
npm --prefix frontend run dev    # Vite dev server; proxies /api to :8787
npm --prefix frontend test       # frontend pure-logic tests (vitest)
npm --prefix frontend run build  # typecheck + build the admin SPA to frontend/dist
```

## Related repos

- `Lesserv-Agent` — the node-side software. Pull, apply, restart, report.
- `Lesserv` — the archived single-node panel this replaces. Reference only.
