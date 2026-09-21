# DEPLOY.md — running the control plane on Cloudflare

The operational runbook for the deployed control plane, including the
smoke checks that prove each milestone claim. Written during M4, ported to
the TypeScript plane at the TS cutover, and kept current by every deploy
that changes a step.

**Values are operator-specific and deliberately absent from this public
repo.** Everywhere below:

| Placeholder | Meaning |
|---|---|
| `cp.example.org` | your control-plane hostname (a proxied hostname on a zone you control) |
| `<d1-database-name>` / `<d1-database-id>` | the D1 database and its UUID from `wrangler d1 create` |
| `<admin-email>` | the identity allowed by the Access allow policy |
| `<your-team>.cloudflareaccess.com` | your Access team domain |

Copy the committed `wrangler.example.jsonc` to the gitignored
`wrangler.jsonc` (the npm pre-hooks do it for you when the file is
missing) and put the real `routes` and `d1_databases` values in that copy:
every wrangler command then reads `wrangler.jsonc` by default. Never
commit the copy.

## What is deployed

| Resource | Value | Notes |
|---|---|---|
| Worker | `lesserv-cloud` | TypeScript (Hono) via `src/worker.ts` |
| Custom domain | `cp.example.org` | proxied, attached by `wrangler deploy` |
| D1 | `<d1-database-name>` (`<d1-database-id>`) | binding `DB` |
| Worker secret | `REALITY_KEY_SECRET` | base64 of 32 bytes; AES-256-GCM key for REALITY private keys |
| Static assets | `frontend/dist` | the admin SPA at `/admin` (nested layout) |
| Access app | whole hostname + path-scoped bypasses | see below |

## Order of operations (first deploy or redeploy)

```powershell
# 0. Local checks must be green first.
#    (one command; the suite executes inside workerd)
npm install
npm test
npm run typecheck
npm run build            # wrangler deploy --dry-run: proves the bundle

# 1. Schema: migrations apply cleanly to a fresh D1. (Local D1 for dev:)
npx wrangler d1 migrations apply <d1-database-name> --local
npx wrangler d1 migrations apply <d1-database-name> --remote
#    Apply migrations BEFORE deploying a Worker that reads new columns —
#    the app selects `*`, so a missing column turns every node query into
#    a 500.

# 2. Secret. Generate a fresh key only for a NEW deployment; rotating an
#    existing one strands every stored key (they are unreadable without it).
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
#    Local workerd: put it in .dev.vars as REALITY_KEY_SECRET=<value>.
#    Production: prefer the API (no encoding surprises):
#      PUT /accounts/<account>/workers/scripts/lesserv-cloud/secrets
#      {"name":"REALITY_KEY_SECRET","text":"<base64>","type":"secret_text"}
#    `npx wrangler secret put REALITY_KEY_SECRET` also works — but see the
#    BOM gotcha below when piping the value from PowerShell.

# 3. Frontend, then the Worker + assets in one unit.
npm --prefix frontend install   # first time only
npm --prefix frontend run build
npm run build && npx wrangler deploy
```

`wrangler deploy` creates the proxied DNS record and the custom-domain
route for your hostname automatically; first activation takes a minute or
two (requests may hang until the cert is issued).

## Cloudflare Access (the admin trust boundary)

Access is configured once, outside this repo (dashboard or API). Check
your account's `deny_unmatched_requests` setting — if it is **false**,
protection must come from an app that covers the hostname, not from
absence.

| Access application | Domain | Decision / policy |
|---|---|---|
| Control plane | `cp.example.org` | allow, include: admin email |
| Bypass node API | `cp.example.org/api/node/*` | bypass, include: everyone |
| Bypass subscriptions | `cp.example.org/sub/*` | bypass, include: everyone |
| Bypass health | `cp.example.org/api/health` | bypass, include: everyone |

**Why there is no `/` bypass.** An Access application for path `/` matches
*every* path on the hostname (measured in M4: with it present,
`/api/admin/nodes` served 200 unauthenticated). The root therefore stays
covered by the broad allow app — visiting `/` shows the Access login
instead of an unprotected SPA shell. That is a deliberate deviation from
the original M4 wording ("bypass policies for `/`..."), and it is the
safer direction: fail closed.

`Cf-Access-Jwt-Assertion` is currently **untrusted**: the header is only
meaningful on Access-covered paths, and no JWT verification or audit
actor extraction exists yet (deferred to a later milestone).

## Smoke checks (run after every deploy)

```powershell
# bypasses reach the app; protected paths get the Access challenge
curl.exe -i https://cp.example.org/api/health            # 200
curl.exe -i https://cp.example.org/api/admin/nodes       # 302 login
curl.exe -i https://cp.example.org/admin/                # 302 login
curl.exe -i https://cp.example.org/sub/x                 # app 404 (NOT a login redirect)
# agent surface, with a minted token:
curl.exe -i https://cp.example.org/api/node/heartbeat -H "Authorization: Bearer <token>" -H "X-Lesserv-Node: <id>" ...
```

The full endpoint sequence (create node → put config → mint token →
enroll → heartbeat → config fetch → report → sync) is pinned by
`tests/workerd/node_protocol.test.ts` locally; run it against the
deployed plane with the same curl steps used for the M4 acceptance run.

Verify the SPA after a deploy that changed `frontend/`:

```
# In a browser, after the Access login:
#   /admin/nodes                 fleet renders every node with drift
#   /admin/nodes/<id>/config     hard-refresh this deep link — it must render
#   /admin/nodes/<id>/keys       REALITY keys, rotate
#   /admin/users/new             per-node access sections, local tags only
# A hard refresh is the point: the asset layer's SPA fallback is
# navigation-only, so a deep link only renders when the browser sends
# Sec-Fetch-Mode: navigate. A bare API-ish request to an unknown path
# still 404s (fail closed), which is the behavior we want.
```

Verify the keys really are ciphertext in D1:

```powershell
npx wrangler d1 execute <d1-database-name> --remote --json `
  --command "SELECT inbound_tag, substr(private_key,1,3) AS prefix FROM reality_keys"
# every row must show "v1:"; anything else means the render ran without
# the secret — fix the secret before trusting the deployment
```

## The TypeScript cutover

The plane was ported from Python (FastAPI on Pyodide) to TypeScript (Hono)
with the byte-frozen outputs — `config_hash`, share URIs, sealed keys,
token hashes — preserved. The parity gate was a hash audit that rendered a
seeded local D1 with both implementations, in both key-generation
directions, and compared every node's desired hash, render, cross-plane
token, and share links; the results are recorded in the Phase 6 finding of
`docs/TS-REWRITE-PLAN.md`. Because the account currently holds no Worker
and no D1, that audit ran locally rather than against a production copy.

**Remaining operator step.** Every deploy from here is a first deploy:
create the D1 (`npx wrangler d1 create <d1-database-name>`), apply
migrations, set `REALITY_KEY_SECRET`, configure the Access applications
above, then `npm run build && npx wrangler deploy`. Your `wrangler.jsonc`
already points `main` at `src/worker.ts`, but its D1 id may still be the
template placeholder — put the fresh database's name and id (and your real
hostname) there before deploying.

**If pre-cutover D1 data is ever restored**, rerun the audit before
sending traffic to it: the only known divergence class is whole-number
floats and oversized integers in stored config text, and the audit is how
you learn whether the data contains them. Both halves of the audit are
recoverable from git — the Python plane from the `python-final` tag and
the temporary audit script from the TS6 commit.

## Point the first agent at the deployed plane

On the VPS running the node (e.g. `node1`), with the agent from
the `Lesserv-Agent` repo already installed per its own installer:

1. Create the node in the deployed plane and mint its token (shown once).
   The share-link domain is optional: set it on the node page after
   creation (or pass `address` in the API call), and after the agent
   enrolls the fleet shows the node's self-reported IP:

   ```powershell
   curl.exe -X POST https://cp.example.org/api/admin/nodes `
     -H "Content-Type: application/json" `
     -d '{\"id\":\"node1\",\"label\":\"Node 1\"}'
   curl.exe -X POST https://cp.example.org/api/admin/nodes/node1/token
   # copy the "token" value — it is never shown again
   ```

2. On the VPS, point the agent at the deployed plane (no code changes —
   this is the M4 headline proof). Either re-run the agent's `enroll`
   command, or edit `/etc/lesserv/agent.toml` (mode `0600`) by hand:

   ```toml
   cp_url = "https://cp.example.org"
   node_id = "node1"
   token = "<paste from step 1>"
   ```

3. Restart the agent service and watch it converge:

   ```bash
   systemctl restart lesserv-agent
   journalctl -u lesserv-agent -f        # enroll, then heartbeat every 30s
   ```

4. Verify from the plane side:

   ```powershell
   # in_sync flips to true after the agent applies and reports
   curl.exe https://cp.example.org/api/admin/nodes/node1/sync
   ```

   Then edit a user on the plane (`POST /api/admin/users` or `PUT`) and
   watch the node's `desired_hash` change on the next heartbeat and the
   agent apply it within one 30-second poll, with no manual action.

Token rotation invalidates immediately: re-minting means repeating steps
1–2 (the agent keeps serving its current config until the new token is in
place — PROTOCOL.md's "token rejected" behavior).

## Point a second node at the deployed plane (M5, operator step)

Adding node #2 takes the same three calls as node #1 and no code change on
either side. The in-repo proof is `tests/workerd/test_two_nodes.py`; the
live half needs a second machine.

1. Create the second node in the fleet view (or with the same `POST
   /api/admin/nodes` call) and paste its config on its Config tab.
2. Mint its token on the node page and copy the plaintext once.
3. On the second machine, install the agent (same `Lesserv-Agent`
   installer) with `--cp <control-plane-url> --node <second-node-id>`, or
   edit its `agent.toml`. Restart the service.
4. Confirm the fleet view shows both nodes converging on their own
   desired hashes, and that each node's Config/Keys/Users pages contain
   only that node's data.

Until a second machine exists, creating node2 in the plane and seeing it
listed as `pending` in the fleet view is the available half of this check;
convergence is the deferred part.

## Gotchas

- **PowerShell pipes a BOM.** `$value | npx wrangler secret put NAME`
  stored the secret with a leading UTF-8 BOM, which made the decoder
  reject it at request time (500s on every render that minted a key).
  `env.secretBytes` strips a BOM defensively, but prefer setting secrets
  through the API. The same BOM rule applies to any value piped into
  wrangler from PowerShell 5.1.
- **Zombie dev servers.** `wrangler dev` respawns `workerd` if the child
  is killed directly; kill the whole tree (`taskkill /F /T` on the
  wrangler node process) or ports stay occupied and requests hang against
  a wedged instance.
- **Observability instead of `wrangler tail`.** On machines whose VPN
  cannot resolve `tail.developers.workers.dev`, use the dashboard's
  Workers Logs (observability is enabled), or a temporary error handler
  while debugging locally.
- **Frontend must be built before deploy.** `wrangler deploy` reads
  `frontend/dist` as its asset directory; a missing directory fails the
  deploy. `npm run build` writes stubs instead, which is fine for a
  dry-run gate and wrong for a real deploy.
- **Keep operator values out of the public repo.** Hostname, D1 name/id,
  Access team, admin email, and every token live in gitignored files
  (`wrangler.jsonc` for the deploy values, `.dev.vars` for the local
  secret) or your Cloudflare account only.
