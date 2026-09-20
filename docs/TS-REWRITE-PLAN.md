# TS-REWRITE-PLAN.md — port Lesserv-Cloud from Python to TypeScript

Executable plan for replacing the Python Worker (`src/**/*.py`, FastAPI +
Pyodide) with TypeScript on workerd, to cut per-request CPU time and cold
start. Derived from the frozen surfaces in `docs/PROTOCOL.md`,
`migrations/*.sql`, the `/api/admin/*` interface the SPA is built on, the
existing test suites as the behavioral spec, and the operator decisions of
2026-09-20: Hono + Zod + `@noble/curves`, big-bang on a branch with the
Python tree tagged, byte-for-byte output parity.

This file is a working checklist. On completion its outcome (not its
process) folds into `PLAN.md`; this file stays as the execution record,
alongside `docs/M0-FINDINGS.md` and the milestone plans.

## Why

The plane runs on Python Workers, which execute on Pyodide: a wasm CPython
interpreter, an FFI boundary for WebCrypto and D1, and a larger deploy
bundle. Steady-state latency is dominated by D1, but every request pays
interpreter and marshalling overhead, and cold starts pay interpreter
initialization. TypeScript executes natively in V8 inside workerd — the
language the runtime is built for — with no bridge and a smaller bundle.

This is a **language port, not a redesign**. Every architecture decision in
`AGENTS.md` survives verbatim: plane renders / agent applies, pull not
push, content-hash convergence, identity-free authored config, Option B
access, plane-owned REALITY keys, per-inbound link profiles, three auth
tiers, fail-closed route groups. The proof of a good port is that the
frontend, the agents, `docs/PROTOCOL.md`, and the database never notice.

## Non-goals (do not build now)

- No M6 subscriptions, M7 stats, or M8 quota work; the port stops at
  behavior parity with the M5 Python plane.
- No schema change, no migration rewrite, no data backfill.
- No frontend rewrite; `frontend/` stays untouched (it is already
  TypeScript).
- No agent change; `protocol: 1` and `docs/PROTOCOL.md` are untouched.
- No new features or loosened validation: status codes, response shapes,
  and strictness stay exactly as they are today.
- No Access/JWT verification work; Cloudflare Access remains the admin
  auth exactly as deployed.

## Frozen surface (the port's specification)

| Surface | Frozen at | Evidence |
|---|---|---|
| Node protocol | `protocol: 1`, every field, 200/409/404 behavior, `actions` | `docs/PROTOCOL.md`; port `tests/workerd/test_node_protocol.py` |
| Database | `migrations/*.sql` unchanged; existing rows stay valid (sealed keys, `token_hash`, `applied_hash`) | `migrations/`; `test_reality.py`'s sealed-key check |
| Admin API | paths, methods, status codes, snake_case JSON, Unix-seconds integers, `{detail}` error envelope | SPA's `frontend/src/api.ts` + `types.ts`; port `tests/workerd/test_admin_*` |
| Route groups | `/api/admin/`, `/api/node/`, `/sub/`, exact `/api/health`; anything else 404 | `route_groups.py`; port `test_guard.py`, `test_route_groups.py` |
| Output bytes | `config_hash` (Python canonical JSON), `vless://` URIs (`urllib.parse.quote` semantics), X25519 base64url-no-pad keys, `v1:` AES-GCM ciphertext, base64url tokens | fixtures generated from the frozen Python before deletion (see Byte parity) |
| Layering | routers (HTTP) -> services (rules) -> `db.ts` (only SQL file); pure core is synchronous; I/O is async | `AGENTS.md` conventions; same file names in TS |
| Asset serving | `frontend/dist` at `/admin/*`, SPA navigation fallback, unknown non-navigation 404 | `test_admin_assets.py`; wrangler `assets` block unchanged |

## Locked decisions

1. **Stack: Hono + Zod + `@noble/curves`.** Hono replaces FastAPI's routing
   and middleware; Zod replaces Pydantic; `@noble/curves` (audited, small,
   tree-shakeable) replaces the hand-rolled Montgomery ladder. Nothing else
   is added — no ORM, no state library, no logger.
2. **Big-bang on a branch, Python tagged `python-final`.** The tagged tree
   stays in git history as the reference implementation. Cutover is one
   Worker deploy; rollback is redeploying the tagged commit.
3. **Byte-for-byte output parity.** `config_hash`, share URIs, key formats,
   and the sealed-key format are reproduced exactly, so no agent re-applies
   on cutover and no share link changes. A pre-cutover hash audit against a
   copy of production D1 is the gate (see Execution plan, Phase 6).
4. **One root `package.json`; the app layout stays flat.** `src/` keeps the
   Python module names (`core/`, `services/`, `routers/`, `db`, `models`,
   `route_groups`) and `tests/` keeps its `pure/` and `workerd/` tiers, so
   the port is file-for-file reviewable and the docs map 1:1.
5. **The Worker is the only runtime, now enforced by the build.** Workerd
   has no Node builtins; `tsc --noEmit`, `vitest` in workerd, and
   `wrangler deploy --dry-run` collectively replace the Python static tests
   (`test_import_hygiene`, `test_no_environment_compat`). They are not
   ported; there is no second runtime left to guard against.
6. **Explicit `env` passing.** Python read the secret from a global
   (`workers.env`); TS passes `env` (`DB`, `REALITY_KEY_SECRET`) from the
   handler into the few services that need it (`key_cipher`, `reality`,
   `render`, `link`). Pure services stay pure and synchronous.
7. **The Python suites are the spec.** Tests are ported one file at a time
   with their assertions intact; the Python tree is not modified during the
   port and is deleted only after the TS suite reaches full parity and the
   deploy smoke passes.

## Target stack and tooling

| Piece | Choice | Notes |
|---|---|---|
| Runtime | workerd via `wrangler` (no `pywrangler`) | `compatibility_flags: ["python_workers"]` removed |
| Router | `hono` | global guard middleware, one sub-app per Python router, `app.onError`, `app.notFound` |
| Validation | `zod` | schemas in `src/models.ts`; default strip of extra keys matches Pydantic's ignore |
| X25519 | `@noble/curves` (`x25519`) | clamp explicitly before `getPublicKey`; RFC 7748 vectors already exist in tests |
| Unit + integration tests | `vitest` + `@cloudflare/vitest-plugin` | tests run inside workerd; `readD1Migrations` + `applyD1Migrations`; `exports.default.fetch()`; per-test isolated D1 storage |
| Types | `tsc --noEmit` strict + `wrangler types` (`worker-configuration.d.ts`, committed) | `src/env.ts` adds secret-decoding helpers on top of the generated `Env` |
| Package manager | npm | root `package.json` + committed `package-lock.json`; `frontend/` keeps its own package tree |
| Scripts | `dev`, `test`, `test:watch`, `typecheck`, `build` (dry-run), `deploy`, `types` | `npm test` is the single suite command |

Pin versions at install time: `@cloudflare/vitest-plugin` with the Vitest
major it declares, `hono` v4, `zod` v4, `@noble/curves` v2 (ESM subpath
imports). The frontend's vitest is independent of the root one.

## Module map (Python -> TypeScript)

Every Python file gets exactly one TS counterpart; behavior moves, shape
stays. LOC shown for scope.

| Python (LOC) | TypeScript | Notes |
|---|---|---|
| `src/worker.py` (14) | `src/worker.ts` | default export of the Hono app from `main.ts` |
| `src/main.py` (60) | `src/main.ts` | guard middleware, router mounts, `onError`/`notFound` JSON |
| `src/route_groups.py` (26) | `src/route_groups.ts` | pure; port verbatim |
| `src/db.py` (363) | `src/db.ts` | direct `env.DB`; same SQL strings; `.all()` reads, `.run()` writes |
| `src/models.py` (287) | `src/models.ts` | Zod schemas + inferred types; same validation messages |
| `src/crypto.py` (80) | `src/crypto.ts` | WebCrypto AES-GCM; same `v1:` format |
| `src/core/x25519.py` (114) | `src/core/x25519.ts` | noble + explicit clamping; base64url no-pad |
| `src/core/allocator.py` (53) | `src/core/allocator.ts` | pure |
| `src/services/labels.py` (46) | `src/services/labels.ts` | pure |
| `src/services/qualify_service.py` (269) | `src/services/qualify_service.ts` | pure |
| `src/services/config_service.py` (157) | `src/services/config_service.ts` | pure |
| `src/services/share_service.py` (340) | `src/services/share_service.ts` | pure; uses `python_uri.ts` |
| `src/services/node_service.py` (97) | `src/services/node_service.ts` | pure helpers + db calls take `db` |
| `src/services/node_state_service.py` (112) | `src/services/node_state_service.ts` | pure helpers + db calls |
| `src/services/node_token_service.py` (37) | `src/services/node_token_service.ts` | WebCrypto SHA-256; constant-time compare |
| `src/services/user_service.py` (114) | `src/services/user_service.ts` | `crypto.randomUUID()` |
| `src/services/key_cipher.py` (59) | `src/services/key_cipher.ts` | takes secret bytes; loud error when unset |
| `src/services/reality_service.py` (92) | `src/services/reality_service.ts` | takes `env` for unsealing |
| `src/services/render_service.py` (86) | `src/services/render_service.ts` | takes `env`; hash via `python_json.ts` |
| `src/services/link_service.py` (74) | `src/services/link_service.ts` | takes `env` |
| `src/services/link_profile_service.py` (79) | `src/services/link_profile_service.ts` | |
| `src/routers/deps.py` (16) | deleted | Hono context replaces the dependency wrapper |
| `src/routers/health.py` (11) | `src/routers/health.ts` | |
| `src/routers/admin_nodes.py` (162) | `src/routers/admin_nodes.ts` | |
| `src/routers/admin_users.py` (144) | `src/routers/admin_users.ts` | |
| `src/routers/admin_reality.py` (63) | `src/routers/admin_reality.ts` | |
| `src/routers/admin_link_profiles.py` (68) | `src/routers/admin_link_profiles.ts` | |
| `src/routers/node.py` (154) | `src/routers/node.ts` | protocol version constant; bearer auth helper |
| — | `src/core/python_json.ts` | canonical JSON + Python float repr (new; parity) |
| — | `src/core/python_uri.ts` | `urllib.parse.quote`/`urlencode` equivalents (new; parity) |
| — | `src/env.ts` | secret-decoding helpers over the generated `Env` (new) |

`tests/__init__.py`, `routers/deps.py`, and the `workers`/`js` FFI imports
have no TS counterpart by design.

## Byte parity (highest-risk workstream)

Three Python behaviors are observable in stored or shared bytes and are
reproduced with dedicated modules and fixtures. Fixtures are generated from
the frozen Python tree by a small committed `scripts/python_fixtures.py`
(kept until the Python tree is deleted; the fixtures themselves stay) and
checked in under `tests/fixtures/`.

### 1. Canonical JSON (`config_hash`)

`render_service.config_hash` uses
`json.dumps(runtime, sort_keys=True, separators=(",", ":"))`. Confirmed
Python behavior that JS `JSON.stringify` does **not** match:

| Input | Python output | JS `JSON.stringify` |
|---|---|---|
| one string with U+00E9 and U+1F600 | `"\u00e9\ud83d\ude00"` (ASCII escapes, lowercase hex, surrogate pair) | literal UTF-8 characters |
| object keys U+FFFD and U+1F600 | U+FFFD first (code-point order) | astral key first (UTF-16 code-unit order) |
| `100.0` | `100.0` | `100` |
| `1e-5` | `1e-05` (two-digit exponent) | `0.00001` |
| `1e21` | `1e+21` | `1e+21` |

`src/core/python_json.ts` implements:

- `canonicalJson(value)`: recursive serializer with Python's separators, the
  `ensure_ascii` escaping rules for strings and object keys (including
  surrogate pairs for astral characters), and a code-point comparator for
  key ordering.
- `pyFloatRepr(n)`: Python `repr(float)` semantics (`1e-05`, `1e+21`,
  `100.0` style, shortest round-trip).
- Integers are emitted as decimal integers.

**Known limit:** once `JSON.parse` has run, a whole-number float literal
(`100.0`) is indistinguishable from an integer, so TS hashes it as `100`.
This is closed operationally by the pre-cutover hash audit below: any
stored config in production that would diverge is found and named before
the switch, not after.

Fixtures: canonical-JSON vectors for unicode strings and keys (BMP and
astral), control characters, integers, floats, exponents, nesting, and key
order; plus the Python-produced hash of a realistic rendered config.

### 2. Share URIs (`urllib.parse.quote` semantics)

`share_service` calls `urlencode(params, quote_via=quote, safe="")` and
`quote(remark, safe="")`. Confirmed differences from
`encodeURIComponent`:

| Input | Python `quote(s, safe="")` | JS `encodeURIComponent` |
|---|---|---|
| `a b!'()*~_-.` | `a%20b%21%27%28%29%2A~_-.` | `a%20b!'()*~_-.` |
| label with space + middle dot + arrow | percent-encoded UTF-8, uppercase hex | same |

`src/core/python_uri.ts` implements `pyQuote(text, safe = "")`
(always-safe `A-Za-z0-9_.-~`, uppercase `%XX`, UTF-8) and `pyUrlEncode`
(pair order preserved, matching Python's insertion order). Fixtures:
Python-generated URIs for the `test_share_service` scenarios and the label
fragment.

### 3. Key and token formats

- **X25519:** decode (URL-safe or standard base64, padding-agnostic), clamp
  the RFC 7748 bits, derive with noble, emit base64url unpadded. Pin the
  RFC 7748 Alice/Bob vectors, the project's fixed keypair fixture, and
  generate/derive round-trips; Python-generated keys must derive the same
  public bytes in TS.
- **AES-GCM:** `v1:` + standard base64 of `iv(12) || ciphertext+tag` under
  `REALITY_KEY_SECRET`. Finding (TS3): the frozen `crypto.py` is a Pyodide
  WebCrypto wrapper, so it cannot seal a fixture under CPython where
  `python_fixtures.py` runs. The fixture therefore pins a published
  AES-256-GCM vector (McGrew & Viega TC14, AES-256, no AAD) plus one
  realistic sealed key, each cross-verified by pyca/cryptography and Node
  WebCrypto before being recorded, with the `v1:` string built by Python's
  own base64 encoder; the TS test re-verifies both through workerd's
  WebCrypto. The live cross-language check moves to the Phase 6 staging
  smoke: Python-sealed rows must keep decrypting after cutover, and a
  TS-sealed row can be round-tripped through the still-deployed Python
  plane.
- **Node token:** `secrets.token_urlsafe(32)` equivalent
  (`crypto.getRandomValues(32)` -> base64url unpadded) and SHA-256 hex hash;
  constant-time compare hand-rolled (WebCrypto has no `timingSafeEqual`).
  Fixture: a Python-generated `token_hash` that TS `verifyToken` accepts.
- **UUIDs:** `crypto.randomUUID()` (v4, lowercase) — same as Python's
  `uuid.uuid4()`. Stability across edits is the tested property, not the
  exact bytes.

## Test strategy

One command, `npm test`, runs the whole suite inside workerd via
`@cloudflare/vitest-plugin`:

- **Pure tier** (`tests/pure/*.test.ts`): modules with no bindings. They run
  in the same workerd pool as everything else (stronger than a node
  environment; still fast).
- **Integration tier** (`tests/workerd/*.test.ts`): imports
  `exports.default` and drives it with `fetch()`; reads D1 through `env.DB`
  for invariants the HTTP surface cannot see (sealed keys). Migrations are
  applied once via `readD1Migrations` + `applyD1Migrations` in a setup file.
  Finding (TS2): `@cloudflare/vitest-plugin` v1.1 has no per-test storage
  isolation — one D1 is shared across the tests in a file — so unique ids
  (`tests/helpers.ts:uid`) are required, exactly like the Python harness,
  not merely nicer failures.
- **Fixtures** (`tests/fixtures/`): Python-generated oracle vectors for
  canonical JSON, URIs, and key/token bytes.
- **Assets** (`tests/workerd/test_admin_assets.test.ts`): the plugin's
  `exports.default.fetch()` does not route static assets, so the three asset
  tests use `env.ASSETS` for the shell check and the documented integration
  harness (`createTestHarness`) for the navigation-vs-non-navigation split.
  A committed `tests/stub-assets/` directory (or a `pretest` stub writer)
  keeps the suite independent of `npm --prefix frontend run build`, exactly
  like the Python harness did.

Port mapping — every Python test file has a TS home. 173 tests today; the
three static tests are replaced by the build/type gates, leaving a target of
roughly 170.

| Python test (tests) | TypeScript | Tier |
|---|---|---|
| `pure/test_x25519.py` (9) | `tests/pure/x25519.test.ts` | unit + fixtures |
| `pure/test_allocator.py` (4) | `tests/pure/allocator.test.ts` | unit |
| `pure/test_labels.py` (3) | `tests/pure/labels.test.ts` | unit |
| `pure/test_qualify_service.py` (11) | `tests/pure/qualify_service.test.ts` | unit |
| `pure/test_config_service.py` (18) | `tests/pure/config_service.test.ts` | unit |
| `pure/test_share_service.py` (12) | `tests/pure/share_service.test.ts` | unit + URI fixtures |
| `pure/test_node_service.py` (8) | `tests/pure/node_service.test.ts` | unit |
| `pure/test_node_state.py` (4) | `tests/pure/node_state.test.ts` | unit |
| `pure/test_node_token_service.py` (6) | `tests/pure/node_token_service.test.ts` | unit + token fixture |
| `pure/test_user_models.py` (11) | `tests/pure/models.test.ts` | unit (Zod) |
| `pure/test_route_groups.py` (2) | `tests/pure/route_groups.test.ts` | unit |
| `pure/test_protocol_freeze.py` (1) | `tests/pure/protocol_freeze.test.ts` | unit |
| `pure/test_import_hygiene.py` (2) | dropped | Pyodide-only; build gates replace it |
| `pure/test_no_environment_compat.py` (1) | dropped | one runtime; build gates replace it |
| `workerd/test_health.py` (1) | `tests/workerd/health.test.ts` | integration |
| `workerd/test_guard.py` (3) | `tests/workerd/guard.test.ts` | integration |
| `workerd/test_admin_assets.py` (3) | `tests/workerd/admin_assets.test.ts` | harness/assets |
| `workerd/test_admin_nodes.py` (9) | `tests/workerd/admin_nodes.test.ts` | integration |
| `workerd/test_admin_users.py` (14) | `tests/workerd/admin_users.test.ts` | integration |
| `workerd/test_admin_sync.py` (7) | `tests/workerd/admin_sync.test.ts` | integration |
| `workerd/test_node_protocol.py` (22) | `tests/workerd/node_protocol.test.ts` | integration |
| `workerd/test_render.py` (5) | `tests/workerd/render.test.ts` | integration |
| `workerd/test_reality.py` (9) | `tests/workerd/reality.test.ts` | integration + `env.DB` |
| `workerd/test_link_profiles.py` (4) | `tests/workerd/link_profiles.test.ts` | integration |
| `workerd/test_two_nodes.py` (4) | `tests/workerd/two_nodes.test.ts` | integration |
| `harness.py` | `tests/helpers.ts` + `vitest.config.ts` setup | infra |

New tests not present in Python:

- `tests/pure/python_json.test.ts` and `tests/pure/python_uri.test.ts` —
  the parity primitives against Python-generated fixtures.
- `tests/pure/crypto.test.ts` — sealed round-trips and the Python
  ciphertext fixture.
- `tests/workerd/error_envelope.test.ts` — status/`detail` contract table
  (422 malformed JSON, 422 validation, 404 guard, 409, 204 bodies, header
  checks such as `Cache-Control: no-store`) to protect the SPA.

The frontend's existing vitest suite is untouched and must stay green; the
wire contract it depends on is re-asserted by the integration tier.

## Execution plan

Each phase is a reviewable commit (repo style: `TS0: scaffold and guard`,
`TS1: parity primitives and pure core`, ...): code, ported tests, and the
docs it invalidates, green together. Read every Python file you port.

### Phase 0 — Freeze, scaffold, guard (size S)

Files: `package.json`, `tsconfig.json`, `vitest.config.ts`,
`worker-configuration.d.ts` (generated), `src/worker.ts`, `src/main.ts`,
`src/env.ts`, `src/route_groups.ts`, `src/routers/health.ts`,
`wrangler.jsonc`, temporary `wrangler.reference.jsonc`,
`tests/pure/route_groups.test.ts`, `tests/pure/protocol_freeze.test.ts`,
`tests/workerd/health.test.ts`, `tests/workerd/guard.test.ts`.

Work:

- Tag the current commit `python-final`; branch `ts-rewrite`.
- Install the stack; strict `tsconfig` (`ES2022`, `moduleResolution:
  bundler`, `jsx` not needed, `types: ["@cloudflare/vitest-plugin/types"]`
  in tests); `npm run types` generates `worker-configuration.d.ts`.
- `vitest.config.ts`: `cloudflareTest({ wrangler: { configPath:
  "./wrangler.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS } } })`,
  with `TEST_MIGRATIONS` from `readD1Migrations("migrations")`, plus a setup
  file that calls `applyD1Migrations`. Override the assets directory to
  `tests/stub-assets` so tests never need a SPA build.
- `src/main.ts`: Hono app, `app.use("*", guard)` backed by
  `route_groups.isAllowedPath`, `app.notFound` and `app.onError` returning
  `{detail: "..."}` JSON, mount `health`.
- `wrangler.jsonc`: `main: "src/worker.ts"`, drop `python_workers`; keep
  D1, assets, routes, observability. `wrangler.reference.jsonc` keeps the
  old Python entry so the Python plane can still be booted as an oracle
  until cutover.
- `tests/stub-assets/` (two tiny HTML files) for the vitest asset override;
  a small prebuild stub writer (or a copy step) keeps `frontend/dist`
  present for `npm run build` on a fresh clone, mirroring the old harness.
- `src/env.ts`: `secretBytes(env)` and friends (the `Env` type itself comes
  from the generated `worker-configuration.d.ts`).

Verify:

```powershell
npm install
npm run typecheck
npm test
npm run build            # wrangler deploy --dry-run
npm run dev              # then: curl.exe -i http://127.0.0.1:8787/api/health
```

### Phase 1 — Parity primitives and pure core (size L)

Files: `src/core/python_json.ts`, `src/core/python_uri.ts`,
`src/core/x25519.ts`, `src/core/allocator.ts`, `src/services/labels.ts`,
`src/services/qualify_service.ts`, `src/services/config_service.ts`,
`src/services/share_service.ts`; `scripts/python_fixtures.py`;
`tests/fixtures/*.json`; ported `tests/pure/*.test.ts` for all six modules
plus the two new parity test files.

Work:

- Implement canonical JSON, Python float repr, `pyQuote`, `pyUrlEncode`.
- Implement x25519 (decode, clamp, derive, generate) with noble.
- Port the pure services verbatim: same function names, same warnings text,
  same ordering and idempotency guarantees.
- Generate fixtures from `python-final` and commit them.

Verify:

```powershell
npm test
npm run typecheck
uv run python scripts/python_fixtures.py --check   # regenerate and diff is empty
```

### Phase 2 — Data layer, models, pure services (size L)

Files: `src/db.ts`, `src/models.ts`, `src/services/node_service.ts`,
`src/services/node_state_service.ts`, `src/services/node_token_service.ts`,
`src/services/user_service.ts`, `src/services/link_profile_service.ts`;
ported pure tests (`node_service`, `node_state`,
`node_token_service`, `models`) and a D1 integration smoke.

Work:

- `db.ts`: one function per Python db function, same SQL text; parameters
  bound the same way; JSON text columns decoded by the same helpers.
- `models.ts`: Zod schemas matching each Pydantic model; refine messages
  matching the Python tests' expectations (`node id must be 1-32 lowercase
  letters or digits`, username rules, profile overrides allow-list,
  non-negative counters, strict ints rejecting booleans).
- Error mapping: validation failures -> HTTP 422 with
  `{"detail": [{"msg": "..."}]}` (the shape `frontend/src/api.ts` parses);
  custom semantic 422s keep `{"detail": ["..."]}` exactly as Python did.

Verify: `npm test`, `npm run typecheck`.

### Phase 3 — Crypto, key custody, tokens (size M)

Files: `src/crypto.ts`, `src/services/key_cipher.ts`,
`src/services/reality_service.ts`, `tests/pure/crypto.test.ts`.

Work:

- AES-GCM via `crypto.subtle`; exact `v1:` envelope; base64 helpers for
  both alphabets; loud failure when `REALITY_KEY_SECRET` is unset, with no
  plaintext fallback (same message intent).
- Token mint/hash/verify with constant-time comparison.
- Fixture test: decrypt a Python-sealed value; verify a Python hash.

Verify: `npm test`.

### Phase 4 — Render, links, and the admin API (size L)

Files: `src/services/render_service.ts`, `src/services/link_service.ts`,
`src/routers/admin_nodes.ts`, `src/routers/admin_users.ts`,
`src/routers/admin_reality.ts`, `src/routers/admin_link_profiles.ts`;
ported integration tests for those surfaces.

Work:

- Render pipeline in the same order: users projection -> `ensure_keys` ->
  qualify config/users/keys -> `build_config` + `apply_reality_keys` ->
  canonical hash. Same malformed-config catch and warning text.
- Routers: same paths (slashless), methods, status codes, response bodies,
  and `Cache-Control: no-store` on config/token responses.
- Port `test_admin_nodes`, `test_admin_users`, `test_render`,
  `test_reality`, `test_link_profiles`.

Verify: `npm test`.

Finding (TS4): the render-dependent half of `node_state_service`
(`desiredHash`, `syncState`) landed in this phase rather than Phase 5,
because the admin sync endpoint is part of the render surface and
`test_render` asserts through it. The render path is async end to end:
WebCrypto's digest is the only SHA-256 in workerd, so `config_hash` is a
promise, and every caller was already async. Porting the malformed-config
catch needed an explicit shape probe: Python's `inbound.get(...)` raised
AttributeError on any non-dict entry, while JS property access on
primitives never throws, so `{"inbounds": "oops"}` would have rendered
garbage instead of warning; `render_service.assertRenderableShape`
restates the requirement and the render catch stays TypeError-only.
Validation bodies are parsed by `models.ts` (`ApiError` + `parseJsonBody`
/ `parseJsonObject`) and rendered by `main.ts`'s `onError` — the port of
FastAPI's single exception handler; `ApiError` is thrown from handlers so
routers read like their Python originals. 41 integration tests ported
(172 total in the suite).

### Phase 5 — Node protocol, sync, two-node proof (size L)

Files: `src/routers/node.ts`, `src/services/node_state_service.ts`
(completion), `tests/workerd/node_protocol.test.ts`,
`tests/workerd/admin_sync.test.ts`, `tests/workerd/two_nodes.test.ts`,
`tests/workerd/admin_assets.test.ts`.

Work:

- Bearer auth helper (401 on every mismatch, nothing logged), protocol
  version check (400), enroll/heartbeat/config/report/stats semantics,
  conditional liveness writes, 409 stale-hash behavior.
- Two-node test: independent renders, independent drift, cross-token 401s,
  byte-identical hashes when untouched.
- Asset tests through `env.ASSETS` + the integration harness.
- Error-envelope test file.

Verify: `npm test` twice in a row, `npm run typecheck`, `npm run build`.

### Phase 6 — Pre-cutover audit, cutover, Python removal, docs (size L)

Files: `scripts/hash_audit.ts` (or `.mjs`), `docs/ARCHITECTURE.md`,
`AGENTS.md`, `PLAN.md`, `README.md`, `docs/DEPLOY.md`, `.dev.vars.example`,
`.gitignore`, plus deletion of the Python tree.

Work:

1. **Hash audit (gate).** With a copy of production D1 (wrangler `d1 export`
   or a local remote fetch) and the production `REALITY_KEY_SECRET`, render
   every node with both implementations and compare `desired_hash`. All
   equal -> proceed. Any divergence is investigated: either fix, or record
   the specific node as a one-time re-apply and get operator sign-off.
2. **Staging deploy** (`wrangler.local.jsonc` currently points at
   `lesserv-test.realumino.org`; update its `main` to `src/worker.ts` and
   drop `python_workers`, then deploy). Full smoke: health, guard, an
   agent enroll/heartbeat/config/report cycle, admin SPA deep link, sealed
   key path, sync shows `in_sync: true` with the existing `applied_hash`.
3. **Production cutover.** Same config change, deploy, run the deployed
   smoke from `docs/DEPLOY.md`.
4. **Delete the Python tree:** `src/**/*.py`, `tests/**`, `pyproject.toml`,
   `pylock.toml`, `uv.lock`, `.venv/`, `.venv-workers/`,
   `python_modules/`, `scripts/python_fixtures.py`, the reference wrangler
   config. Remove Python entries from `.gitignore`. Keep
   `docs/M0-FINDINGS.md` as a historical record with a one-line banner that
   it describes the Pyodide era.
5. **Docs pass.** Re-describe the stack in `AGENTS.md` (run commands, test
   tiers, gotchas: canonical JSON, no Node builtins, `env` passing,
   `wrangler types`); rewrite `ARCHITECTURE.md`'s runtime/test/layering
   sections while keeping every conceptual section (render pipeline,
   qualifier table, data model, trust boundaries, SPA) intact; update
   `README.md` and `docs/DEPLOY.md` commands; `PLAN.md` gains a status
   paragraph and a "TS rewrite" row. `docs/PROTOCOL.md` and `migrations/`
   are not touched.
6. **Performance record.** Measure before (Python, from today's deployed
   logs/metrics) and after (TS) on the same request mix: bundle size
   (`wrangler deploy --dry-run` output), cold start, and request CPU time
   from Workers Logs/analytics under a heartbeat-plus-admin load. Record
   the numbers in `PLAN.md`; if CPU did not improve materially, say so.

Verify (final):

```powershell
npm test
npm run typecheck
npm run build
npm --prefix frontend test
npm --prefix frontend run build
```

## Done criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | Full behavioral parity | Every ported Python test has a green TS counterpart (>= 170 tests); the port mapping above is the checklist |
| 2 | Byte parity for hashes and URIs | `python_json`/`python_uri` fixture tests; pre-cutover hash audit shows every production node's `desired_hash` unchanged |
| 3 | Existing data stays valid | Python-sealed key ciphertext decrypts in TS; TS-sealed ciphertext decrypts in Python (before deletion); `token_hash` fixture verifies; a node keeps `in_sync: true` across the cutover |
| 4 | The frontend never notices | `frontend/` untouched and its vitest suite green; integration tests pin statuses, `{detail}` envelope, snake_case, Unix seconds, `Cache-Control: no-store` |
| 5 | The agent never notices | `docs/PROTOCOL.md` untouched; protocol freeze test passes; a live agent converges with no re-apply |
| 6 | One runtime, enforced | `npm run build` (wrangler dry-run) succeeds with no `python_workers` and no Node builtins; `tsc --noEmit` clean |
| 7 | Python is gone | `uv`, `pywrangler`, FastAPI, Pydantic, and the Pyodide test harness have no remaining references in the repo (checked by grep) |
| 8 | CPU/cold-start claim measured | Before/after numbers recorded in `PLAN.md` |
| 9 | Docs are true | `AGENTS.md`, `ARCHITECTURE.md`, `README.md`, `docs/DEPLOY.md` describe the TS reality; `PLAN.md` carries the rewrite outcome |

## Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Canonical JSON divergence | A different hash makes every node re-apply once; worse, if the hash is wrong only on rare inputs, it is invisible until production | Dedicated serializer + Python-generated fixtures + pre-cutover hash audit as a hard gate; known `100.0` limit documented and audited |
| URI encoding divergence | Share links are copied by users and pinned by tests; silent `!'()*` differences change bytes | `pyQuote`/`pyUrlEncode` with fixtures; `test_share_service` ported verbatim |
| noble x25519 clamping or key format | Wrong `pbk` breaks every REALITY client | Explicit clamp + RFC 7748 vectors + the project's fixed keypair; cross-derive Python-generated keys |
| Existing sealed keys unreadable | Every rendered config fails to render; outage | Python-ciphertext fixture decrypt test before anything else ships; fail-loud on missing secret preserved |
| Zod/Pydantic strictness drift | Loosened validation becomes an API contract change; tightened validation breaks the SPA | Port `test_user_models` and every 422 case; add the error-envelope test; keep `{"detail": ...}` shapes |
| Hono behavior differences (trailing slash, 204 body, malformed JSON) | fetch follows redirects; the SPA branches on exact statuses | Slashless canonical routes pinned by tests; malformed JSON -> 422; explicit status assertion table |
| Static-asset tests do not survive the test pool | The navigation fallback and fail-closed 404 are load-bearing | `env.ASSETS` + `createTestHarness` for the three asset tests; `tests/stub-assets` so tests never need a SPA build |
| `wrangler.local.jsonc` still points at `src/worker.py` | Deploy would fail or ship the stale entry | Explicit operator step in Phase 6 and in `docs/DEPLOY.md`; dry-run gate in Phase 0 onward |
| Fixtures generated after Python is gone | No oracle for future parity questions | Generate and commit fixtures in Phase 1, before any deletion; the generator is deleted only at cutover |
| Scope creep while porting ("improve this") | Divergence grows review size and breaks the test-as-spec property | Non-goals above; test-by-test port checklists; no refactors, no renames, no new warnings |
| Performance win not delivered | The rewrite's stated reason | Phase 6 measurement step with defined metrics; report honestly even if the win is modest (D1 dominates steady state; cold start and bundle size are the expected wins) |

## New and removed files

Added (beyond the module map): root `package.json`/`package-lock.json`,
`tsconfig.json`, `vitest.config.ts`, `worker-configuration.d.ts`,
`tests/fixtures/*`, `tests/stub-assets/*`, `tests/helpers.ts`,
`scripts/python_fixtures.py` (temporary), `scripts/hash_audit.*`
(temporary), `wrangler.reference.jsonc` (temporary), this plan.

Removed at cutover: `src/**/*.py`, `tests/**` (Python),
`pyproject.toml`, `pylock.toml`, `uv.lock`, `.venv/`, `.venv-workers/`,
`python_modules/` (gitignored but worth deleting locally),
`wrangler.reference.jsonc`, the temporary scripts, and the Python sections
of `.gitignore`.

Unchanged throughout: `migrations/*.sql`, `docs/PROTOCOL.md`,
`frontend/**`, `wrangler.jsonc`'s D1/assets/routes/observability blocks,
`.dev.vars` (local), Cloudflare Access configuration.

## Starting point

Phase 0 begins with:

```powershell
git tag python-final
git switch -c ts-rewrite
npm init -y
npm install hono zod @noble/curves
npm install -D wrangler typescript vitest @cloudflare/vitest-plugin @types/node
npx wrangler types
```

If a hard blocker appears (noble behavior, an irreproducible Python output,
a vitest-pool limitation), stop and record the finding in this file before
inventing a workaround; the frozen surfaces above are the contract, and a
deviation is a decision, not an implementation detail.

## Out of scope (do not build now)

Subscriptions (M6), stats/dashboard (M7), quota (M8), schema changes,
Access-JWT verification and the audit actor, `config_versions` diff and
rollback, agent changes of any kind, `docs/PROTOCOL.md` changes, Terraform,
frontend changes (including new pages, polling, or bulk endpoints), node
deletion, and any "while we are here" refactor of the API shape.


