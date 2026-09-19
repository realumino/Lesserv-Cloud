# M4-PLAN.md — control plane on Workers + D1

Executable plan for milestone 4, derived from `PLAN.md`'s M4 done-when list,
`docs/PROTOCOL.md` (frozen target), the M0 constraints in
`docs/M0-FINDINGS.md`, the M1–M3 code as it exists (`db.py` already carries
`D1Conn`; `crypto.py` already speaks the `v1:` format), and the operator's
Cloudflare account state measured before writing this file (an active
zone, an empty D1 database, an Access team, no Worker and no self-hosted
Access app — account values are deliberately absent from this public
repo; `docs/DEPLOY.md` holds the placeholder vocabulary).

This file is a working checklist. When M4 lands, its outcome (not its
process) folds into `PLAN.md`.

## Goal

Move the already-proven render pipeline and the `protocol: 1` contract onto
the real platform without touching the agent: the Worker runs the same
FastAPI app on D1, the SPA is served from static assets under `/admin`,
Cloudflare Access guards the admin surface, and REALITY private keys are
sealed with a Worker secret. The local `uvicorn`+SQLite path keeps working;
the deployed plane becomes what the VPS agent converges against.

## Done criteria (from PLAN.md, made testable)

| # | Criterion | Proof |
|---|---|---|
| 1 | Agent converges against the **deployed** plane with zero code changes | VPS agent (`cp_url=https://cp.example.org`) enrolls → heartbeats → applies → reports; a user edit propagates ≤30s; `Lesserv-Agent` tree unchanged; `PROTOCOL_VERSION == 1` both sides |
| 2 | `db.py` signatures unchanged, bodies speak D1 | every table round-trips through `D1Conn` under workerd (local and remote D1); all SQL re-audited for the D1 dialect; no signature change |
| 3 | Routers and services are `async` | every def touching `conn` is `async def`; full suite + workerd smoke green |
| 4 | Migrations apply cleanly to a fresh D1 | `wrangler d1 migrations apply <d1-database-name> --remote` on the empty database succeeds; `sqlite_master` table set matches the SQLite backend's |
| 5 | Access protects admin, bypasses the public paths | curl matrix: `/api/admin/*` and `/admin/*` → 302 login; `/`, `/sub/*`, `/api/node/*`, `/api/health` reach the app (200/401/404, never a login redirect) |
| 6 | SPA under `/admin` with SPA fallback + matching Vite `base` | `base: '/admin/'` in `vite.config.ts`; `/admin/`, `/admin/assets/*`, and a deep link all return the shell |
| 7 | REALITY private keys unreadable without the Worker secret | D1 `private_key` values start `v1:`; the runtime pane still derives the public key (proves decrypt); unit tests cover the plaintext fallback and the no-secret-on-ciphertext error |
| 8 | `docs/PROTOCOL.md` frozen at `protocol: 1` | header note added; `tests/test_node_protocol.py` pins `PROTOCOL_VERSION == 1` |

## Decisions locked for M4

1. **Hostname is the operator's own proxied hostname** (`cp.example.org`
   in this repo's placeholder vocabulary), attached to the Worker as a
   proxied custom domain (`routes` + `custom_domain: true`). Access needs
   a zone, so `workers.dev` is not used. Real values live only in a
   gitignored `wrangler.local.jsonc`.
2. **Reuse the operator's existing empty D1 database** as binding `DB`,
   carrying its real name/id in `wrangler.local.jsonc`. It was empty, so
   "fresh D1" was literally true and no data migration was needed.
3. **Static assets own `/admin`.** The route-group guard keeps its **four**
   prefixes unchanged; `/admin/*` never invokes the Worker, so the locked
   trust-boundary invariant is preserved. The SPA shell is also reachable at
   `/` (an Access bypass), but every byte of data stays behind
   Access-protected `/api/admin/*`.
4. **Minimal placeholder SPA now; M5 replaces the contents.** M4 ships the
   Vite project, the `base`, the build layout, and the serving path; M5
   fills in the real UI without changing any of it.
5. **Key sealing is ambient with a plaintext fallback.**
   `services/key_cipher.py` resolves `REALITY_KEY_SECRET` from `workers.env`
   inside the function; under CPython it returns `None` and stores
   plaintext. Ciphertext is distinguished by the existing `v1:` prefix, so
   legacy plaintext rows keep reading. No one-time re-encrypt is required
   (remote D1 starts empty).
6. **No new schema migration in M4.** `audit_log` and Access-JWT actor
   verification are deferred (see gaps).
7. **Access default-deny is a broad allow app, not absence.**
   `deny_unmatched_requests` is `false` on this account, so protection comes
   from a whole-hostname app with an allow policy plus four path-scoped
   **bypass** apps; absence would fail open.
8. **Deploy is an operator runbook, not IaC.** No Terraform dependency;
   exact commands and API calls live in `docs/DEPLOY.md`.

## Explicit deviations and known gaps

- **The shell is public at `/`.** SPA fallback always serves the root
  `index.html`; that same file is reachable at `/` (bypassed). It contains
  no secrets and its assets sit under Access-protected `/admin/`, so an
  unauthenticated visit to `/` may see the shell and then an Access
  challenge on assets. Accepted and documented.
- **No Access-JWT verification, no `audit_log`.** The
  `Cf-Access-Jwt-Assertion` header is present but treated as untrusted;
  mutations are not yet attributed to an actor.
- **Secret rotation is a re-seal, not implemented.** Rotating
  `REALITY_KEY_SECRET` without re-encrypting stored keys would strand them;
  the read path raises rather than silently misbehaving.
- **No automated cloud CI.** Deploy and Access setup are manual and
  documented; local `uvicorn`+SQLite remains the fast test lane.
- **Local frontend dev uses the Vite dev server** (with an `/api` proxy),
  not the Python app, because `local.py` has no assets binding.
- **Ambient `workers.env` is the one unproven assumption.** Step 1's
  workerd probe decides it; the pre-designed fallback is threading
  `request.scope["env"]` from `routers/deps.py` into the render path.

## Target module map

### New

| File | Job |
|---|---|
| `src/services/key_cipher.py` | `seal` / `open`; resolves `REALITY_KEY_SECRET` via `workers.env`, plaintext fallback, `v1:` discriminator |
| `frontend/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.ts` | Minimal Vite SPA shell with `base: '/admin/'` and the root-index fallback plugin |
| `tests/test_key_cipher.py` | Plaintext fallback, `v1:` detection, no-secret error, round-trip via a fake cipher |
| `docs/DEPLOY.md` | Reproducible deploy + Access + smoke runbook |

### Adapted

| File | Change |
|---|---|
| `wrangler.jsonc` | Real `database_id`/`database_name`; `assets` block; custom-domain route; `workers_dev: false` |
| `src/services/reality_service.py` | Seal on write, unseal on read |
| `src/db.py` | Bodies only, and only if the workerd smoke exposes a D1 quirk; **signatures unchanged** |
| `tests/test_import_hygiene.py` | Add `services.key_cipher` to the poisoned-import list |
| `tests/test_node_protocol.py` | Pin `PROTOCOL_VERSION == 1` |
| `tests/test_reality_service.py` | Seal/unseal behavior through the service API |
| `docs/PROTOCOL.md` | Freeze header at `protocol: 1` |
| `ARCHITECTURE.md` | Key custody sealed; Access live; entrypoints; SPA surface; `audit_log` still later |
| `PLAN.md`, `AGENTS.md`, `README.md`, `.gitignore` | M4 status; deploy commands; frontend present; ignore `frontend/dist/` |

### Deleted

None. (`db.py`'s D1 path already exists from M0; M4 proves and hardens it
rather than replacing it.)

## Platform configuration

### `wrangler.jsonc`

```jsonc
{
  "name": "lesserv-cloud",
  "main": "src/worker.py",
  "compatibility_date": "2026-09-17",
  "compatibility_flags": ["python_workers"],
  "workers_dev": false,
  "routes": [{ "pattern": "cp.example.org", "custom_domain": true }],
  "d1_databases": [{
    "binding": "DB",
    "database_name": "lesserv",
    "database_id": "00000000-0000-0000-0000-000000000000"
  }],
  "assets": {
    "directory": "./frontend/dist",
    "not_found_handling": "single-page-application"
  },
  "observability": { "enabled": true }
}
```

The committed config carries placeholders; real values live in the
gitignored `wrangler.local.jsonc` and every remote command runs with
`--config wrangler.local.jsonc` (local dev uses the placeholder config and
a local D1 database).

### Frontend build layout

`frontend/vite.config.ts`: `base: '/admin/'`, `build.outDir: 'dist/admin'`,
plus an inline plugin whose `writeBundle` copies `dist/admin/index.html` →
`dist/index.html` so the SPA fallback has a root index. Request mapping:

| Request | Served | Why |
|---|---|---|
| `/admin/` | `dist/admin/index.html` | directory index under the mirrored path |
| `/admin/assets/*` | `dist/admin/assets/*` | asset URL = `base` + `assetsDir` |
| `/admin/nodes/tokyo01` | `dist/index.html` | SPA fallback |
| `/api/*`, `/sub/*` | Worker | no matching asset |

### Secret

```powershell
uv run python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
```

Local workerd: `REALITY_KEY_SECRET=<base64>` in `.dev.vars` (gitignored).
Production: `npx wrangler secret put REALITY_KEY_SECRET`.

### Access applications

| App domain / destination | Decision |
|---|---|
| `cp.example.org` | allow `<ADMIN_EMAIL>` |
| `cp.example.org/api/node/*` | bypass |
| `cp.example.org/sub/*` | bypass |
| `cp.example.org/api/health` | bypass |
| `cp.example.org/` | bypass |

Prerequisites confirmed at execution: the admin email (or email domain) for
the allow policy, and an API token with Workers/D1/Access/DNS edit scopes.

Note (from execution): the `/` bypass row was **withdrawn** — an Access
application for path `/` matches every path on the hostname, which
un-protects everything. The root stays covered by the broad allow app
instead; see `docs/DEPLOY.md`.

## Execution plan

Each step is a reviewable unit: code + tests + the docs it invalidates, all
green together. Read every touched file before moving on.

### Step 0 — Write this plan; provision platform config

Files: this file; edit `wrangler.jsonc`, `.gitignore`.

Work: land the wrangler config above; ignore `frontend/dist/`; confirm the
D1 binding resolves.

Verify: `npx wrangler d1 info <d1-database-name>`; `npx wrangler deploy
--dry-run`.

### Step 1 — REALITY key sealing

Files: add `src/services/key_cipher.py`, `tests/test_key_cipher.py`; edit
`src/services/reality_service.py`, `tests/test_import_hygiene.py`.

Work:

- `_secret_bytes()` imports `workers.env` inside `try/except ImportError`
  (so CPython stays clean), reads `REALITY_KEY_SECRET`, base64-decodes.
- `seal()` encrypts via `crypto.encrypt` when a secret exists, else returns
  plaintext.
- `open()` returns legacy plaintext unchanged; decrypts `v1:`; raises a
  clear error for `v1:` with no secret.
- `reality_service`: `key_map`/`public_key`/`list_keys` unseal;
  `ensure_keys`/`rotate_key` seal before `upsert_reality_key`.

Verify:

```powershell
uv run python -m unittest tests.test_key_cipher tests.test_reality_service tests.test_render_service -v
uv run python -m unittest tests.test_import_hygiene -v
```

Probe (the one real uncertainty): under `uv run pywrangler dev` with
`.dev.vars` set, save a config with a REALITY inbound and confirm the stored
key is sealed:

```powershell
npx wrangler d1 execute <d1-database-name> --local --command "SELECT inbound_tag, substr(private_key,1,3) FROM reality_keys"
```

### Step 2 — D1/workerd parity proof

Files: edit `src/db.py` only if a quirk appears; extend `docs/DEPLOY.md`.

Work: apply migrations to local D1 via wrangler, run the full M3 endpoint
sequence against `pywrangler dev`, and diff the `sqlite_master` table set
against the SQLite backend's. Re-audit SQL for the D1 dialect (expected: no
changes).

Verify: the sequence in `docs/DEPLOY.md` against `:8787`.

### Step 3 — Placeholder SPA

Files: add `frontend/**`; edit `.gitignore`, `docs/DEPLOY.md`.

Work: Vite + TypeScript shell at `base: '/admin/'`, `outDir dist/admin`,
`writeBundle` root-index copy, dev proxy for `/api` and `/sub`.

Verify: build, then `/admin/`, `/admin/assets/*`, and a deep link through
`pywrangler dev`.

### Step 4 — Deploy

Files: none (runbook only).

Work: migrations remote → secret → build → deploy → DNS.

```powershell
npx wrangler d1 migrations apply <d1-database-name> --remote
npx wrangler secret put REALITY_KEY_SECRET
npm --prefix frontend run build
npx wrangler deploy
```

Verify: remote table list; `https://cp.example.org/api/health` → 200.

### Step 5 — Cloudflare Access

Files: none; record the exact calls in `docs/DEPLOY.md`.

Work: create the broad allow app and the four bypass apps.

Verify (the criterion-5 matrix):

```powershell
curl.exe -i https://cp.example.org/api/admin/nodes      # 302 login
curl.exe -i https://cp.example.org/admin/               # 302 (or 200 after login)
curl.exe -i https://cp.example.org/api/health           # 200
curl.exe -i https://cp.example.org/api/node/heartbeat   # 401 app auth, NOT a login redirect
curl.exe -i https://cp.example.org/sub/x                # app 404, NOT a login redirect
```

### Step 6 — Docs and protocol freeze

Files: `docs/PROTOCOL.md`, `ARCHITECTURE.md`, `PLAN.md`, `AGENTS.md`,
`README.md`.

Work: freeze PROTOCOL at `protocol: 1`; rewrite key custody (sealed, not
"until M4"); mark Access live; describe the D1/assets/secret entrypoint and
the `/admin` static surface; correct "no frontend in the repo" language;
update the M4 row/status. Add the `PROTOCOL_VERSION` pin test.

### Step 7 — Deployed agent convergence proof (headline)

Files: none in this repo.

Work (on the VPS running the node): create the node + mint a
token in the deployed plane; set `agent.toml` (`cp_url=https://
cp.example.org`, node id, token, mode 0600); restart the agent; then
edit a user on the plane and watch drift close.

Verify: enroll → `desired_hash` set / `applied_hash` null / `in_sync:
false` → apply+report → `in_sync: true`; a user edit converges within one
30s poll with no agent code change.

### Step 8 — Closeout

Full `ARCHITECTURE.md` read-through; `PLAN.md` M4 row → done; full suite +
deployed smoke matrix green.

## Test inventory

| File | Origin | Coverage |
|---|---|---|
| `tests/test_key_cipher.py` | new | plaintext fallback, `v1:` detection, no-secret error, fake-cipher round-trip |
| `tests/test_reality_service.py` | updated | seal-on-write / unseal-on-read through the service API |
| `tests/test_node_protocol.py` | updated | `PROTOCOL_VERSION == 1` pin |
| `tests/test_import_hygiene.py` | extended | `key_cipher` imports clean under poisoned PRNG |
| rest of suite | unchanged | all 194 tests stay green on SQLite |

Run: `uv run python -m unittest discover -s tests -t . -v`

## Out of scope (do not build now)

`audit_log` + Access-JWT actor verification; the real frontend (M5); node #2
(M5); subscriptions (M6); stats accumulation/dashboard (M7); quota (M8);
secret rotation/re-seal tooling; `hmac-v1`; agent self-update; R2 mirror;
Terraform.

## Risks and gotchas

- **Ambient `workers.env` is the one unproven assumption.** Step 1's
  workerd probe decides it; the dependency-threading fallback is
  pre-designed.
- **`db.py` is virtually done.** Don't rewrite it for the D1 port; prove
  it. Any change must be a body-only, signature-preserving fix.
- **Assets are served before the Worker**, so `/admin` is invisible to the
  route guard by design — never let that grow into a new API prefix.
- **Access fails open by absence on this account**
  (`deny_unmatched_requests: false`); the broad allow app is mandatory
  before any real data exists.
- **Ordering at deploy:** migrations and secret before the first request
  that renders a key, or a render will store plaintext.
- **Never log** `Authorization`, tokens, UUIDs, private keys, or secret
  values.
- **No entropy at import time:** `key_cipher`'s `workers` import and
  `crypto.encrypt`'s `os.urandom` are function-local (already true).
- **Determinism:** sealing adds a random IV per write, but `config_hash` is
  computed from the decrypted rendered config, so desired hashes stay
  byte-stable.
