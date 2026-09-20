# M5-PLAN.md — node #2 and the new frontend

Executable plan for milestone 5, derived from `PLAN.md`'s M5 done-when, the
frozen M4 API surface (`src/models.py`, `src/routers/*`), the archived
panel's React UI as reference only, the M4 serving arrangement
(`base: '/admin/'`, `dist/admin`, root-index fallback), and the operator
decisions of 2026-09-20 (React + React Router + Tailwind v4; API frozen;
link profiles get minimal CRUD; vitest for pure logic; local fake agents
carry the two-node proof).

This file is a working checklist. When M5 lands, its outcome (not its
process) folds into `PLAN.md`.

## Outcome (executed 2026-09-20)

Landed as planned, with these recorded deviations:

- **Dependency majors moved at install time.** The placeholder pinned Vite
  7 and the current `@vitejs/plugin-react` (6.x) requires Vite 8, so the
  matched set is Vite 8 + React 19 + react-router 8 + Tailwind 4 + vitest 5,
  pinned in the committed `package-lock.json`. The `strict` TS config and
  `tsc --noEmit` gate are unchanged.
- **One test was added beyond the module map:**
  `tests/workerd/test_admin_assets.py`. Testing the deep link exposed that
  Workerd's SPA fallback is navigation-only (it serves the root index only
  when `Sec-Fetch-Mode: navigate` is present); a bare request to an unknown
  path still reaches the Worker and 404s. Both halves are now pinned and
  documented rather than assumed.
- **The harness stub writes both `dist/index.html` and
  `dist/admin/index.html`**, so the workerd tier boots and exercises asset
  serving on a fresh clone with no SPA build.
- **A few shared frontend pieces were added** that the module map did not
  list individually: `components/styles.ts`, `components/Field.tsx`, and
  `components/Modal.tsx`.
- **The live browser walkthrough was not completed here.** Workerd boot on
  the development machine was intermittently failing at startup with a TLS
  error (`kj/compat/tls.c++: peer disconnected ...`), independent of app
  code. Serving is covered by the asset test and the API by the workerd
  tier; the browser walkthrough and second-machine convergence remain the
  operator-run acceptance item recorded in `docs/DEPLOY.md`.

## Goal

Two things, one milestone:

1. **Prove the plane was already a fleet.** A second node is created with
   the same API calls as the first — no `src/` change anywhere — and the
   two nodes converge, drift, and fail independently.
2. **Replace the placeholder SPA** with the real TypeScript admin UI: a
   fleet view, node detail pages (config authored vs rendered, keys,
   authorized users, link profiles), and a user form whose access editor
   is per-node sections with local tags only.

No protocol change. No agent change. No schema change. The Python diff is
tests only.

## Done criteria (from PLAN.md, made testable)

| # | Criterion | Proof |
|---|---|---|
| 1 | Two nodes converge independently | `tests/workerd/test_two_nodes.py`: two nodes, two configs, two fake agents; each renders its own qualified tags and keys; A's apply leaves B drifted |
| 2 | Neither can observe the other | Same file: cross-token reads 401; a user edit on A flips A's desired hash and leaves B's byte-identical |
| 3 | Adding node #2 requires no code change anywhere | The test creates both with identical calls; no `src/` file mentions a node id; deployed acceptance creates node2 through the UI with no deploy in between |
| 4 | Fleet view shows health, last-seen, applied hash, last error | `frontend/src/lib/fleet.test.ts` pins the join (including missing/failed sync); live check against a two-node local plane |
| 5 | Node detail exposes config (authored vs rendered), keys, authorized users | Routes `/admin/nodes/:nodeId/{config,keys,users,profiles}`; live deep-link check |
| 6 | User form is per-node sections, label header, local tags inside | `frontend/src/lib/access.test.ts` pins authoritative-map semantics and local-tag-only payloads; live create/edit on a two-node plane |
| 7 | TypeScript + router + real Tailwind build | `package.json` deps; `index.html` has no `cdn.tailwindcss.com`; `npm run build` runs `tsc --noEmit && vite build` |
| 8 | `/admin/nodes/tokyo01/config` is a real, refreshable URL | Deep link returns the shell (200) through the local plane; browser refresh renders the config page — `BrowserRouter basename="/admin"` matches Vite `base: '/admin/'` |

## Decisions locked for M5

1. **React + React Router + Tailwind v4.** Continuity with the archived
   panel's React UI; router gives real URLs. Runtime deps: `react`,
   `react-dom`, `react-router` (+ `qrcode.react`, kept from the archived
   panel because VLESS links are imported on phones). Build deps:
   `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`,
   `@types/react`, `@types/react-dom`, `@types/node`, `vitest`. No state
   library, no component library, no testing-library.
2. **The API is frozen.** The fleet view composes `GET /api/admin/nodes` +
   `GET /api/admin/nodes/{id}/sync` (parallel); the node's users page
   filters `GET /api/admin/users`; token setup state is inferred from sync
   `state: "pending"` plus an explicit rotation confirm. `src/` gains zero
   code.
3. **Link profiles get minimal CRUD** on the node detail page (list,
   create, edit, delete). The UI edits `overrides` as validated JSON; the
   local `inbound_tag` comes from a select of the node's authored inbounds.
4. **Vitest tests pure logic only** — `lib/access.ts`, `lib/format.ts`,
   `lib/fleet.ts`. No jsdom. `tsc --noEmit` and `vite build` gate
   everything else.
5. **Access is not reimplemented in the SPA.** Cloudflare Access owns
   login; the client detects non-JSON responses (an expired session returns
   the login HTML) and says "session may have expired — reload".
6. **N+1 fetches are deliberate.** At this fleet scale the sync endpoint is
   the drift view; a bulk endpoint is a later change if the fleet outgrows
   it. Documented, not hidden.
7. **No node deletion** (no API), **no subscriptions** (M6), **no stats**
   (M7).
8. **The SPA never stores secrets**: node tokens live only in the mint
   dialog's state, never in localStorage; the runtime pane is read-only and
   admin-only.

## The API surface the SPA builds on (all existing)

| Endpoint | Used by |
|---|---|
| `GET/POST /api/admin/nodes`, `GET/PUT /api/admin/nodes/{id}` | fleet list, create form, node header |
| `GET /api/admin/nodes/{id}/sync` | fleet rows, node header, warnings |
| `GET /api/admin/nodes/{id}/config`, `PUT …` | authored pane, save |
| `GET /api/admin/nodes/{id}/config/runtime` | rendered pane, hash, warnings |
| `GET /api/admin/nodes/{id}/inbounds`, `…/outbounds` | user-form tag lists, profiles inbound select |
| `POST /api/admin/nodes/{id}/token` | mint dialog (plaintext shown once) |
| `GET /api/admin/nodes/{id}/reality`, `POST …/reality/rotate`, `POST …/reality/{tag}/rotate` | keys page |
| `GET/POST/PUT/DELETE /api/admin/nodes/{id}/link-profiles[/{profileId}]` | profiles page |
| `GET /api/admin/users`, `GET/PUT/DELETE /api/admin/users/{username}` | users list, user form |
| `GET /api/admin/users/{username}/links` | share dialog |
| `GET /api/admin/status` | header counts |

Status codes the pages must implement: config 404 = empty state;
inbounds/outbounds 503 = "config not loaded"; save 422 = show the error
list; users 404/409; links 404/409/503 (show `detail`).

## The SPA's shape

### Routes (`BrowserRouter basename="/admin"`)

```
/admin/                         → redirect to /admin/nodes
/admin/nodes                    → FleetPage
/admin/nodes/:nodeId            → NodeLayout  (index → redirect to config)
/admin/nodes/:nodeId/config     → NodeConfigPage     ← the named M5 URL
/admin/nodes/:nodeId/keys       → NodeKeysPage
/admin/nodes/:nodeId/users      → NodeUsersPage
/admin/nodes/:nodeId/profiles   → NodeProfilesPage
/admin/users                    → UsersPage
/admin/users/new                → UserEditPage (create)
/admin/users/:username          → UserEditPage (edit)
/admin/*                        → NotFoundPage
```

### Route table

| Route | Data fetched | Shows |
|---|---|---|
| Fleet | `nodes`, then `Promise.all(sync per node)` | label, id, address, state badge (pending/active), in-sync/drifted/error, health, last-seen relative, applied hash short, last error, warnings count; Create node; link to detail |
| Node layout | `node`, `sync` | header: label, id, address, state, desired/applied hash, versions, last-seen; tab nav; mint-token action |
| Config | `config` (404 → empty), `config/runtime`, `sync` | authored vs rendered side by side, rendered hash + warnings, paste-and-save box, save errors |
| Keys | `reality` (404 → empty) | inbound local tag, public key + copy, created_at, Rotate / Rotate all (confirm) |
| Node users | `users` filtered by `access[nodeId]` | username, status, expiry, allowed local tags; link to editor |
| Profiles | `link-profiles`, `inbounds` (503 → prompt) | id, inbound, label, overrides; create/edit/delete |
| Users | `users`, `nodes` | status, expiry, note, per-node membership summary; Add, Edit, Share, Delete |
| User form | `nodes`, then per-node `inbounds`+`outbounds`, plus `user` on edit | global fields + one section per node: auth toggle, label header, local inbound/outbound checkboxes |

### Data flow

- Each page owns its fetch (`useEffect` + `useState`), refetches after
  every mutation; no global store.
- `api.ts` returns `{ data, error, status }`; `detail` strings and FastAPI
  422 lists are flattened to one message; non-JSON responses become the
  session-expired message.
- No polling timers; every page has a Refresh action. The pull model is the
  fleet's, not the browser's.

### Access form semantics (the risky part)

- Sections are built from the node list (`label` as header, `id` as
  subtitle), never from strings.
- `formFromUser(user, nodes)`: authorized = node id present in
  `user.access`; tags copied out of the stored lists; `uuids` never enter
  the form.
- `toAccessPayload(form)`: only authorized nodes appear; lists contain
  exactly the checked local tags; a node toggled off disappears — which is
  authoritative removal (server deletes the access row).
- A node whose config is missing has no tag lists; the section still allows
  membership with empty lists, with the same "config not loaded" note the
  server state implies.
- Qualified names appear nowhere the admin can type: only in the read-only
  rendered config and generated links.

## Target module map

### Frontend — new

| File | Job |
|---|---|
| `frontend/src/main.tsx` | React root; `BrowserRouter basename="/admin"`; imports `index.css` |
| `frontend/src/App.tsx` | Shell (header/nav/counts) + route table + NotFound |
| `frontend/src/api.ts` | Typed client for `/api/admin/*`; error normalization; non-JSON detection |
| `frontend/src/types.ts` | Response/request types mirroring `src/models.py` |
| `frontend/src/index.css` | Tailwind v4 `@import` + `@theme` apple palette + system font stack |
| `frontend/src/lib/format.ts` | `shortHash`, `relativeTime`, `fmtExpire`, `fmtTimestamp` |
| `frontend/src/lib/access.ts` | Pure per-node access form state ↔ payload |
| `frontend/src/lib/fleet.ts` | Pure join of nodes + per-node sync into display rows |
| `frontend/src/lib/{access,format,fleet}.test.ts` | Vitest, pure logic |
| `frontend/src/pages/FleetPage.tsx` | Fleet table + create-node form |
| `frontend/src/pages/NodeLayout.tsx` | Node header + tabs + `<Outlet/>`; node + sync fetch |
| `frontend/src/pages/NodeConfigPage.tsx` | Authored vs rendered, save, warnings, hash |
| `frontend/src/pages/NodeKeysPage.tsx` | REALITY keys list + rotate |
| `frontend/src/pages/NodeUsersPage.tsx` | Users authorized on this node |
| `frontend/src/pages/NodeProfilesPage.tsx` | Link profiles CRUD |
| `frontend/src/pages/UsersPage.tsx` | User list + membership summary + actions |
| `frontend/src/pages/UserEditPage.tsx` | Create/edit user with per-node sections |
| `frontend/src/components/TokenDialog.tsx` | Mint-once token display, copy, rotation warning |
| `frontend/src/components/ShareLinksDialog.tsx` | Links, copy per link, copy all, QR |
| `frontend/src/components/{CopyButton,Badge,HashChip,JsonPanel,ConfirmButton,ErrorNote,EmptyState}.tsx` | Small display primitives |

### Frontend — adapted

| File | Change |
|---|---|
| `frontend/package.json` | Deps + scripts `dev`, `build` (`tsc --noEmit && vite build`), `typecheck`, `test` |
| `frontend/vite.config.ts` | Add `react()` + `tailwindcss()`; keep `base`/`outDir`/spa-fallback; fix dev proxy to `127.0.0.1:8787`; vitest section |
| `frontend/index.html` | `main.tsx`; no CDN; system font |
| `frontend/tsconfig.json` | `jsx: react-jsx`; include tests; strict stays |

### Backend — unchanged

None. `src/` gains no code. The only Python change is tests.

### Tests — new

| File | Coverage |
|---|---|
| `tests/workerd/test_two_nodes.py` | Two-node convergence, isolation, independence |
| `frontend/src/lib/access.test.ts` | Form ↔ authoritative access map; local tags only |
| `frontend/src/lib/format.test.ts` | Hash shortening, relative time buckets, expiry |
| `frontend/src/lib/fleet.test.ts` | Row join, missing sync → unknown (never a crash) |

### Adapted tests

| File | Change |
|---|---|
| `tests/workerd/harness.py` | `_ensure_assets()`: write a stub `frontend/dist/index.html` when missing, so a fresh clone can boot the workerd tier before the first `npm run build` |

### Deleted

| File | Why |
|---|---|
| `frontend/src/main.ts` | Replaced by `main.tsx` |

### Docs

| File | Change |
|---|---|
| `docs/M5-PLAN.md` | This file (Step 0) |
| `ARCHITECTURE.md` | New "The admin SPA (M5)" section: routes, data flow, N+1 rationale, access-form semantics; correct "placeholder until M5"; note the two-node proof |
| `PLAN.md` | M5 status paragraph + row; the M4 VPS operator item and the M5 second-machine item both stay visible |
| `AGENTS.md` | Run-it gains frontend commands and the frontend test tier; "no real frontend yet" paragraph rewritten |
| `README.md` | Frontend dev/build/test commands |
| `docs/DEPLOY.md` | New SPA smoke checks; second-node procedure (local fake agents; real machine deferred) |

## Execution plan

Each step is a reviewable unit: code + tests + the docs it invalidates,
green together. Read every touched file before moving on.

### Step 0 — Land this plan

Files: `docs/M5-PLAN.md`; `PLAN.md` (M5 row → in progress).

Work: commit the plan so the milestone's decisions are reviewable before
code.

Verify: markdown only.

### Step 1 — Two-node proof (backend, no frontend)

Files: add `tests/workerd/test_two_nodes.py`; edit
`tests/workerd/harness.py`; edit `ARCHITECTURE.md`.

Work:

- `_config(exit_tag)` helper like `test_render.py`'s; each node gets its
  own exit (`alpha`/`beta`) and REALITY inbound.
- `test_two_fake_agents_converge_independently`: create A and B (same
  calls); create `shared` on both and `onlyA` on A; mint both tokens;
  enroll/heartbeat/fetch both; assert A's rendered config contains
  `shared@A-alpha` and `onlyA@A-alpha`, B's contains `shared@B-beta` and
  not `onlyA`; A's and B's hashes and `pbk`s differ; report applied on A
  only; A `in_sync`, B still drifted with `applied_hash` null.
- `test_user_edit_on_one_node_leaves_the_other_hash_unchanged`: converge
  both; capture desired hashes; add a user to A only; A's hash flips, B's
  is byte-identical.
- `test_config_change_on_one_node_leaves_the_other_hash_unchanged`.
- `test_cross_node_reads_stay_401`: A's token with `X-Lesserv-Node: B` on
  config and heartbeat.
- Harness stub: before `_start_server`, create `frontend/dist/index.html`
  if absent (wrangler fails on a missing assets directory; `dist/` is
  gitignored, so a fresh clone cannot boot otherwise).

Verify:

```powershell
uv run python -m unittest discover -s tests/workerd -t . -v
```

The new file plus all 71 existing workerd tests green, twice in a row
(shared D1, unique ids).

Docs: `ARCHITECTURE.md` — one paragraph in the render/pipeline area:
per-node render and per-node keys are what make two nodes provably
independent.

### Step 2 — Frontend toolchain and shell

Files: `frontend/package.json`, `frontend/vite.config.ts`,
`frontend/tsconfig.json`, `frontend/index.html`, `frontend/src/index.css`,
`frontend/src/main.tsx`, `frontend/src/App.tsx` (placeholder routes);
delete `frontend/src/main.ts`.

Work:

- Install: `react`, `react-dom`, `react-router`, `qrcode.react`; dev:
  `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`,
  `@types/react`, `@types/react-dom`, `@types/node`, `vitest` (pin the
  vitest major that matches the installed Vite).
- Port the archived palette into Tailwind v4 `@theme` (`--color-apple-*`),
  system font stack (drop the Google Fonts CDN; no external requests).
- `App.tsx`: shell + routes from the table above, pages as stubs.
- Keep M4's serving arrangement byte-for-byte: `base: '/admin/'`,
  `build.outDir: 'dist/admin'`, `spaFallback()`;
  `server.proxy['/api']` corrected to `http://127.0.0.1:8787`.

Verify:

```powershell
npm --prefix frontend install
npm --prefix frontend run typecheck
npm --prefix frontend run build
Select-String -Path frontend/index.html -Pattern "cdn.tailwindcss.com"   # no match
uv run pywrangler dev
curl.exe -i http://127.0.0.1:8787/admin/                     # 200 shell
curl.exe -i http://127.0.0.1:8787/admin/nodes/x/config       # 200 shell (fallback)
curl.exe -i http://127.0.0.1:8787/admin/assets/<hash>.js     # 200 asset
```

Docs: `README.md` frontend commands; `AGENTS.md` Run it.

### Step 3 — Typed API client and pure logic (with vitest)

Files: `frontend/src/api.ts`, `types.ts`, `lib/format.ts`,
`lib/access.ts`, `lib/fleet.ts` + three test files; vitest config if not
already in `vite.config.ts`.

Work:

- `api.ts`: one `request()`; 204 → null; 422 `detail` list flattened;
  non-JSON body → `"Session may have expired — reload the page"`; typed
  wrappers for every endpoint in the table.
- `access.ts`: `emptyAccessForm`, `formFromUser`, `toggleNode`,
  `toggleTag`, `toAccessPayload` as specified above.
- `fleet.ts`: `fleetRows(nodes, syncByNode)`; missing/failed sync yields
  `unknown`, never throws.
- `format.ts`: `shortHash` (8 chars), `relativeTime` (never/now/min/hours/
  days), `fmtExpire`, `fmtTimestamp`.

Verify:

```powershell
npm --prefix frontend test
npm --prefix frontend run typecheck
```

### Step 4 — Fleet view

Files: `frontend/src/pages/FleetPage.tsx`; `App.tsx` wiring.

Work: list nodes; parallel sync fetches; the display columns from the
route table; Create node form (id pattern hint `[a-z0-9]{1,32}`, label,
address) posting `POST /nodes` then navigating to the new node; explicit
Refresh; error and empty states.

Verify (live, two nodes on the local plane): create `tokyo01` and
`toyama01` through the UI; both rows render with independent state; a
fake-agent enrollment later flips `pending → active`; refresh shows it.

Docs: `ARCHITECTURE.md` — SPA section draft.

### Step 5 — Node detail shell, config pane, token dialog

Files: `NodeLayout.tsx`, `NodeConfigPage.tsx`, `components/TokenDialog.tsx`.

Work: layout fetches node + sync, renders header and tabs; config pane
renders authored vs rendered side by side (mobile: stacked), rendered
`hash` + `warnings`, paste-and-save with JSON parse + 422 display,
refetches runtime and sync after save; empty states for 404; token dialog:
confirm (rotation warning when `state: "active"`), `POST token`, show
plaintext once with Copy, never persist.

Verify:

```powershell
curl.exe -i http://127.0.0.1:8787/admin/nodes/tokyo01/config   # 200 shell (refreshable URL)
```

Browser: hard-refresh the deep link → the config page renders; save a
bad-tag config → 422 list displayed; mint a token → copy; re-mint → old
token 401 (curl).

Docs: `ARCHITECTURE.md`; `DEPLOY.md` smoke gains the deep-link check.

### Step 6 — Keys page

Files: `NodeKeysPage.tsx`.

Work: `GET reality` (404 → "load a config first"), row per inbound local
tag with public key + copy + created_at, Rotate per row and Rotate all
with confirm, empty state when no REALITY inbounds.

Verify: live — rotate one key; the rendered config's `pbk` changes and
generated links change with it; a node with no REALITY inbounds shows the
empty state.

### Step 7 — Node users and profiles

Files: `NodeUsersPage.tsx`, `NodeProfilesPage.tsx`.

Work: node users = `GET users` filtered by `access[nodeId]`; show allowed
local tags and status; link to the user editor. Profiles: list; create (id
slug, inbound select from `GET inbounds`, label, overrides JSON textarea
validated client-side and server-side); edit via `PUT`; delete with
confirm; 503 → "load a config first".

Verify: live — create profile `cdn` on `reality`; the user's share links
gain the profile variant (compare `GET /users/{u}/links` before/after);
delete removes it.

Docs: `ARCHITECTURE.md` links/profiles section — "managed from the node
detail Profiles tab since M5".

### Step 8 — Users list, per-node user form, share dialog

Files: `UsersPage.tsx`, `UserEditPage.tsx`,
`components/ShareLinksDialog.tsx`.

Work: users list with membership summary (`nodeLabel: N in / M out`),
Add/Edit/Share/Delete; form fetches nodes then per-node inbounds+outbounds;
per-node sections exactly as the semantics section describes; create
`POST` / edit `PUT` (access always submitted, authoritative); delete with
confirm; share dialog lists links (label, node, qualified tags, URI), copy
per link, copy all, QR toggle.

Verify: live — create a user authorized on both nodes; the form
round-trips; unchecking a node and saving removes its access row
(`GET /users/{u}` proves it); links include both nodes' addresses; the API
never sees a qualified tag in a request body (assert in a curl log).

Docs: `ARCHITECTURE.md` — "Life of a change: the admin edits a user"
(form now per node).

### Step 9 — Docs, deploy, acceptance, closeout

Files: `ARCHITECTURE.md`, `PLAN.md`, `AGENTS.md`, `README.md`,
`docs/DEPLOY.md`, `docs/M5-PLAN.md`.

Work:

- Full docs pass (below).
- Build + deploy: `npm --prefix frontend run build`;
  `npx wrangler deploy --config wrangler.local.jsonc`.
- Deployed smoke: Access challenge on `/admin/`; after login, hard-refresh
  `/admin/nodes/<node1>/config`; fleet shows node1; **create node2 through
  the UI with no deploy in between** (criterion 3 made literal) and confirm
  the fleet renders two independent rows. Node2 stays `pending` until a
  second machine exists — recorded as an operator item, like M4's VPS step.
- Local two-node acceptance in `DEPLOY.md`: two nodes on `pywrangler dev`,
  two fake-agent sequences (the workerd test's HTTP steps as curl), each
  converged and isolated.

Verify (final):

```powershell
uv run python -m unittest discover -s tests/pure -t . -v
uv run python -m unittest discover -s tests/workerd -t . -v
npm --prefix frontend test
npm --prefix frontend run build
```

## Test inventory

| File | Origin | Coverage |
|---|---|---|
| `tests/workerd/test_two_nodes.py` | new | independence, isolation, user-edit/config-change locality |
| `tests/workerd/harness.py` | adapted | boot without a built SPA |
| `frontend/src/lib/access.test.ts` | new | authoritative map, member toggles, local tags only |
| `frontend/src/lib/format.test.ts` | new | hash/time/expiry formatting |
| `frontend/src/lib/fleet.test.ts` | new | row join, unknown sync |
| rest of the suite | unchanged | 84 pure + 71 workerd stay green |

## Out of scope (do not build now)

Subscriptions (M6); stats/dashboard (M7); quota (M8); node deletion (no
API); bulk fleet endpoint (until scale demands); automatic UI polling;
Access-JWT verification/audit actor; `config_versions` diff/rollback; agent
changes of any kind; `PROTOCOL.md` (stays frozen at `protocol: 1`);
Terraform; frontend e2e (Playwright).

## Risks and gotchas

- **The dev proxy is stale.** `vite.config.ts` still proxies `/api` to
  `:8000`, the dead uvicorn port; M5 must point it at `:8787` or the dev
  workflow silently fails.
- **`frontend/dist` is gitignored and required.** wrangler fails when
  `assets.directory` is missing; the harness stub fixes fresh clones, and
  `npm run build` must precede the workerd tier on a clean tree.
  `DEPLOY.md` already says build before deploy.
- **Access redirects return HTML.** After a session expires, fetch follows
  the login redirect and gets 200 HTML; `api.ts` must detect non-JSON and
  tell the admin to reload instead of showing a JSON parse error.
- **The root-index fallback is load-bearing.** Deep links resolve through
  `spaFallback()`'s copy; removing it breaks `/admin/nodes/*` refresh.
  `base: '/admin/'` and `basename="/admin"` must stay in lockstep.
- **The route guard's four prefixes stay the whole API.** The SPA only ever
  calls `/api/admin/*`; nothing may grow a new prefix for UI convenience.
- **Tokens are shown once.** The dialog holds the plaintext in component
  state only; no localStorage, no logging, no cache headers on the mint
  response (already `no-store` server-side).
- **The runtime pane displays REALITY private keys by design** (admin,
  behind Access). Do not add client caching or share that pane.
- **`has_token` does not exist**, so the UI infers setup state from
  `state: "pending"`; rotating an active node's token is confirm-gated
  because it invalidates the agent's credentials immediately.
- **Tailwind v4 is CSS-first.** The archived `apple-*` classes only work
  after the `@theme` port; a half-port fails silently (unknown classes are
  dropped).
- **Dependency versions move.** Install the vitest major that matches the
  installed Vite, and React/React Router as a current matched pair; pin
  exact versions in `package-lock.json` (committed).
- **N+1 is deliberate.** Each fleet refresh performs one render per node;
  record that in `ARCHITECTURE.md` so it is a decision, not an accident.
- **No entropy, no environment branches** apply to `src/` only; the SPA is
  outside those tests, but it must not invent a second API prefix or store
  secrets.
