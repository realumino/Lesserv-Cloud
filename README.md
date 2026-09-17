# Lesserv-Cloud

The control plane for a fleet of VLESS/Xray nodes. It stores nodes, users,
per-node access, and REALITY keys; renders each node's runtime Xray config;
and serves it to the agent on that node, which applies it and reports back
what it actually ran.

Nodes are independent — they never talk to each other, and exits are
external endpoints (WireGuard, Shadowsocks, VLESS) that the panel does not
manage.

## Documents

| File | What it holds |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Stable context: what this is, locked decisions, how to run it, conventions, gotchas |
| [`PLAN.md`](PLAN.md) | Volatile state: the milestone roadmap and current status |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The walkthrough: render pipeline, data model, trust boundaries, request flows |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | The cross-repo contract with [`Lesserv-Agent`](https://github.com/realumino/Lesserv-Agent) |

## Related repos

- `Lesserv-Agent` — the node-side software. Pull, apply, restart, report.
- `Lesserv` — the archived single-node panel this replaces. Reference only.
