# PROTOCOL.md — the contract between Lesserv-Cloud and Lesserv-Agent

This file is the **single source of truth** for the node protocol. It lives
in the control-plane repo because the control plane is the server and owns
the contract; `Lesserv-Agent` links here rather than copying anything.

**Status: frozen at `protocol: 1` as of M4** — the deployed control plane
serves this exact contract, and the agent converges against it with zero
code changes. Any change to a field's meaning is a new version, coordinated
across both repos and this document together.

Two repos implement this document, so it is versioned and it is binding.
The rule that keeps them in sync: **the plane may always speak older
protocol versions; the agent never guesses.**

## Versioning

Every request that reaches `/api/node/*` carries the protocol version the
agent speaks, and every response that carries behavior carries it back.

- Current version: **`protocol: 1`**
- The agent declares what it speaks on every enroll, heartbeat, and report.
- The plane keeps working with older versions as long as it can serve them
  faithfully. It must never silently reinterpret a payload from a version
  it does not understand — if it cannot honor a version, it says so
  explicitly and the node stays on its last known good config.
- Additive fields are allowed within a version. A field's meaning never
  changes within a version; that requires a new version.
- `protocol` is a plain integer. There is no negotiation dance: the agent
  states a number, the plane answers with what it will do.

## Identity and authentication

A node is created in the control plane **before** any machine can identify
as it. There is no self-registration and no open enrollment: enrolling
hands over a rendered config containing every authorized user's UUID for
that node, so an unknown machine must never be able to ask.

1. The admin creates the node (id, label, public address). The plane mints
   a 32-byte random token, displays it **once**, and stores only its
   SHA-256 hash. The node's state is `pending`.
2. The admin places the token on the machine — in `agent.toml` (mode
   `0600`), or by running the agent's `enroll` command which writes it.
   The token should be read from stdin or a file, never passed as a
   command-line argument: arguments land in `ps` output and shell history.
3. The agent's first authenticated request is `enroll`.
4. From then on the agent uses the same token for every request.

Every request carries:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <token>` |
| `X-Lesserv-Node` | the node id, so errors and logs can name the node |
| `Content-Type` | `application/json` |

The plane looks the node up by id, compares the token hash with a
constant-time comparison, and scopes **every** subsequent query to that
node. A node must never be able to read another node's data; this is the
one invariant that deserves an explicit test.

Authentication schemes are versioned in the agent's local configuration
(`auth: "bearer-v1"` today). A future `hmac-v1` signs
`method\npath\ntimestamp\nnonce\nsha256(body)` with a shared secret and
sends a timestamp and nonce instead of the token. Because the scheme is a
field, a fleet can migrate one node at a time and the protocol version
does not change.

Token rotation invalidates immediately, which creates a chicken-and-egg
problem: the admin must update the file on the machine. Two acceptable
answers, in order of preference: allow a short grace window where both the
old and new hashes are valid, or have the heartbeat response carry the new
token for the agent to persist. The first is simpler; the second is nicer.

## Common rules

- **Idempotency.** Every endpoint is safe to retry. `enroll` may be called
  repeatedly; `heartbeat` and `report` may be duplicated; `config` is a
  read. An agent that restarts, crashes, or runs twice must converge to the
  same state.
- **Errors.** Non-2xx responses carry a JSON body with a human-readable
  message. The agent's response to any error is to keep serving the current
  config and retry with backoff — never to change or delete anything.
- **Empty is not a command.** A response that is missing a field, empty, or
  malformed is treated exactly like a network failure. Only an explicit,
  complete, newer config causes a change on the node.
- **Clock.** Timestamps in payloads are Unix seconds. The plane is the
  authority on time; the agent's clock only matters for `hmac-v1`, which
  will need a tolerance window.

## Endpoints

### `POST /api/node/enroll`

First contact from a node that already exists. Records the facts the plane
should only have to ask once.

Request:

```json
{
  "protocol": 1,
  "agent_version": "0.1.0",
  "xray_version": "25.1.1",
  "platform": "linux/x86_64",
  "detected_ip": "203.0.113.7"
}
```

`detected_ip` is the agent's best guess at its own public address. It is a
**suggestion** for the admin to accept, not a fact the plane adopts
silently: the node's advertised address is what share links contain, and
that is an admin decision (`funky.example.com` is not the same as an IP).

Response: the node's metadata — id, label, advertised address, whether the
plane considers it `pending` or `active`, and the desired hash if a config
is already waiting.

Re-running enroll is idempotent and is the correct action after the admin
edits `agent.toml`.

### `POST /api/node/heartbeat`

The only endpoint on a timer. Must be cheap.

```json
{
  "protocol": 1,
  "applied_hash": "ab12…",
  "applied_at": 1758000000,
  "xray_running": true,
  "xray_pid": 412,
  "agent_uptime": 86400,
  "last_error": null
}
```

Response:

```json
{ "desired_hash": "cd34…", "actions": [] }
```

The agent compares `desired_hash` with its own `applied_hash`. If they are
equal **and** the last apply succeeded, there is nothing to do — that is
the entire idempotency story, and it covers reboots, agent restarts, and
duplicate polls. If they differ, or the last apply failed, the agent fetches
the config.

The plane uses heartbeats for liveness and drift display, but does not
assume anything from their absence: a node's state in the dashboard is
always "as last reported". A missing heartbeat is information, not an
event.

### `GET /api/node/config?hash=<desired_hash>`

Returns the fully rendered runtime config for this node, already qualified,
already containing clients and routing rules, with the REALITY private keys
injected.

- `200` with `{hash, config}` when the URL hash matches the desired hash
  (the normal fetch), or when no `hash` is given.
- `409` with `{detail, desired_hash}` when the URL hash no longer matches:
  the plane moved on between the agent's heartbeat and its fetch, so the
  agent re-heartbeats instead of applying bytes it did not ask for.
- `404` when the node has nothing renderable.

The hash in the URL is a guard against stale reads, not a security
mechanism — and the `hash` in the response is the other half: the agent
verifies the returned hash equals the one it asked for before touching
disk. There is deliberately no `304`: without an agent-side cache of
fetched bytes a "not modified" answer can only strand the agent (it
needs the bytes precisely when it asks), and configs are kilobytes
fetched solely on change. The response is the exact bytes the node should
run; the agent does not transform it, does not merge it, and does not
validate its semantics beyond `xray -test`.

### `POST /api/node/report`

The result of an apply attempt. This is what makes drift visible.

```json
{
  "protocol": 1,
  "hash": "cd34…",
  "ok": true,
  "stage": "applied",
  "xray_exit_code": null,
  "error": null
}
```

`stage` is one of `fetched`, `test`, `applied`, `started`, `rolled_back`.
A failure reports the stage where it failed and the error text; a failure
at `test` or `started` also means the node rolled back, which the plane
records so the dashboard can say "apply failed, rolled back" rather than
"out of sync".

A report that never arrives is not a problem: the next heartbeat re-syncs
reality. Reports are for diagnosis and for the audit trail, not for
correctness.

### `POST /api/node/stats`

Traffic counters from the node's local Xray API. Ships in the agent from
v1 even though the dashboard comes later, so history accumulates.

```json
{
  "protocol": 1,
  "boot_id": "b3f1…",
  "counters": {
    "user>>>alice@tokyo01-niigata>>>traffic>>>uplink": 1048576,
    "user>>>alice@tokyo01-niigata>>>traffic>>>downlink": 8388608
  }
}
```

Values are **absolute**, not deltas, and `boot_id` changes whenever Xray
restarts. The plane stores the last-seen value per (node, email) and
accumulates `max(0, new - old)`, treating a decrease or a changed `boot_id`
as a reset. Absolute-plus-boot-id is what makes retries safe; deltas
computed on the node are not, because a retried report would double-count.

## The apply sequence

The agent's obligations, in order. Steps 3 and 4 are what keep a bad config
from ever reaching a running service.

1. Compare `desired_hash` with the local `applied_hash`. Equal and last
   apply succeeded → stop.
2. Fetch the config and write it to a temporary file.
3. **Test it**: run Xray's config test against the temporary file. A
   non-zero exit means the live config is never touched.
4. **Snapshot**: copy the currently running config to a last-good file,
   but only if the last apply succeeded — otherwise the snapshot would
   preserve a broken config as the fallback.
5. **Swap atomically**: rename the temporary file over the live config, so
   Xray can never read a half-written file.
6. **Restart and verify**: restart Xray, then confirm it is actually
   running (process alive after a grace period, optionally a listen check).
7. If it died, restore the snapshot, restart, and report the failure.
8. Persist the applied hash and report success.

Two crash-safety rules:

- **Startup check.** On agent start, test the *live* config. If it fails,
  restore last-good and restart. This single rule makes the agent safe to
  kill at any moment, including between steps 5 and 8.
- **No config, no change.** The agent only ever changes the live config in
  response to an explicit, complete, newer config. An unreadable response,
  a 5xx, a truncated body, or a missing field is a network failure.

## Failure and offline behavior

| Situation | Agent behavior |
|---|---|
| Plane unreachable | Keep serving. Back off 5s → 300s with jitter. Change nothing. |
| Xray down, plane reachable | Fetch and apply normally; the desired state is what matters. |
| Xray down, plane unreachable | Try to start the last-good config. |
| Config fails the test | Keep running the current config. Report `stage: "test"`. |
| Config starts then dies | Roll back to last-good. Report `stage: "started"`. |
| Token rejected | Keep serving, back off harder, surface the error locally. Do not retry in a tight loop. |

The design assumption is that **a node must remain useful while the control
plane is down for a day.** Staleness is the only cost of an outage; a node
never degrades itself because it lost contact.

## Actions

`actions` in the heartbeat response is the escape hatch for things that are
not config changes. Version 1 defines exactly one:

| Action | Meaning |
|---|---|
| `restart_xray` | Restart the running Xray with the current config, unchanged. |

Everything else is expressed as a new rendered config. Do not grow this
list casually — each entry is behavior that lives outside the
render-compare-apply loop, which is the property that makes the system
easy to reason about.

## What each side may assume

**The plane may assume:** the agent writes only files it owns, restarts
only its own Xray, reports honestly, and never transforms the config it
receives.

**The agent may assume:** the config it receives is complete and final —
qualified, with clients, rules, and private keys included. It needs no
knowledge of users, nodes, exits, or policy. If the config references a
file, that file is the agent's business; if it references a port, binding
that port is the agent's business. Nothing about *who* is allowed what is
the agent's business.

That asymmetry is the contract's whole purpose: everything the fleet
knows stays in one place, and the node holds none of it.
