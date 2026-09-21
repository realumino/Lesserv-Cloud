# M6-PLAN.md — subscriptions

Executable plan for milestone 6, derived from `PLAN.md`'s M6 done-when, the
current TypeScript plane (Hono + Zod + D1), the M5 admin surface and SPA, the
existing cross-node link aggregation behind
`GET /api/admin/users/{username}/links`, and the operator decisions of
2026-09-21 (plaintext `sub_token`, auto-mint at user creation, `200`-empty
for unknown tokens, one `SubscriptionCard` in the share dialog and the user
edit page).

This file is a working checklist. When M6 lands, its outcome (not its
process) folds into `PLAN.md`.

## Outcome (executed 2026-09-21)

Landed as planned, with these recorded notes:

- **The rotation endpoint landed during Step 3–4** rather than as a separate
  step: the `SubTokenOut` import needed to exist for the typecheck gate, and
  the endpoint is four lines over `user_service.rotateSubToken`.
- **One test-harness edit was required**, and it is not a behavior change:
  `tests/workerd/db.test.ts` constructs rows by calling `db.createUser`
  directly, so it needed the two new required fields.
- **Two iterations in the new test file itself**: the cross-user isolation
  test asserted the qualified email appears in the URI, but since M2 the
  remark is a readable label — the UUID is the per-user secret in a URI, so
  the test now asserts each body carries its own user's UUID and never the
  other's; and the enrichment test dropped a duplicated first PUT that
  granted node B the wrong exit tag.
- **The local dev smoke initially failed with `no such table: nodes`** — the
  local D1 simply had no migrations applied (an environment state, not a
  code bug). `npx wrangler d1 migrations apply lesserv --local` applied all
  four migrations including 0004 cleanly, and the full smoke then passed
  live: mint → serve (base64 decodes to the expected URI) → rotate (old URL
  empty, new URL serves) → disable (empty) → unknown token (200 empty) →
  `/sub/`, `/sub/x/extra`, and `POST /sub/x` all 404.
- **`docs/DEPLOY.md`'s `/sub/x` smoke expectation changed from "app 404" to
  "200 empty body"**: before M6 the path had no route and 404'd; now any
  single-segment token is a valid-shaped request that answers empty. The
  fail-closed property (still not a login redirect, still 404 for the bare
  group root, extra segments, and non-GET verbs) is preserved and now
  pinned by `tests/workerd/subscriptions.test.ts`.
- **The final suite is 236 workerd/pure tests plus 23 frontend tests**;
  the existing admin-links, link-profiles, and two-node tests were not
  edited (criterion 7's gate for the aggregation refactor).

## Goal

Give every user one stable, rotatable capability URL — `/sub/{token}` — that
returns **base64 of the newline-joined list of every VLESS link that user is
entitled to, across every node, with each link carrying its own node's
address**. The body is exactly the admin link list encoded, so the two views
can never disagree. Anything not entitled to links (unknown token, disabled,
expired, nothing configured) gets a `200` with an empty body — never a
`404`/`409`/`503`. Adding node #2 to a user's access enriches the same URL's
body; the URL itself never changes.

Flow:

```
client → GET /sub/{token}
plane  → users.sub_token lookup            (db.getUserBySubToken)
       → entitlement check                 (status active, expire unset/0/future)
       → linkService.userLinks             (same aggregation the admin links route uses)
       → encodeSubscription(links.uri)     (standard base64, "\n" join)
       → 200 text/plain; charset=utf-8, Cache-Control: no-store
         (empty body when not entitled)
```

No protocol change (`PROTOCOL.md` stays frozen at `protocol: 1`). No agent
change. No Access change — the `/sub/*` bypass has existed since M4. One
migration. The API is additive: `UserOut` gains two fields and one new POST
endpoint.

## Done criteria (from PLAN.md, made testable)

| # | Criterion | Proof |
|---|---|---|
| 1 | A user has a rotatable `sub_token` | `tests/workerd/subscriptions.test.ts`: create → 43-char base64url token in the response; `POST .../sub-token` returns a different token with `no-store`; `GET` the user shows the new one |
| 2 | `/sub/{token}` returns the base64 newline-joined list of every entitled link | Same file: `atob(body).split("\n")` deep-equals `GET .../links`' `links.map(l => l.uri)` for a two-node user |
| 3 | Each link carries its own node's address | Two nodes (`a.example.com`, `b.example.com`); the decoded A-links contain only A's host and B-links only B's |
| 4 | Disabled or expired users get an empty body rather than an error | Same file: disabled → `200 ""`; past expiry → `200 ""`; re-enable → same URL returns links again; never 404/409/503 |
| 5 | Adding node #2 enriches an existing subscription URL without changing it | Same file: capture URL + decoded body on node A; add B to the user's access; token/URL byte-identical, body gains B's links and keeps A's |
| 6 | Unknown or rotated-out tokens are indistinguishable | Same file: `/sub/<never-minted>` and `/sub/<rotated-away>` both `200`, empty, `text/plain`, `no-store` |
| 7 | The admin links endpoint is behaviorally unchanged | `tests/workerd/admin_users.test.ts`, `link_profiles.test.ts`, `two_nodes.test.ts` stay green with **zero edits** through the aggregation refactor |

## Decisions locked for M6

1. **Plaintext `sub_token` at rest** *(operator-confirmed)*. It is a
   capability URL the admin must be able to re-display (users lose URLs; the
   recovery path is a copy, not a rotation). A database dump already
   contains every UUID in `user_node_access`, so hashing the token would
   protect nothing that is not already exposed, while making the URL
   unreadable. Rotation is the revocation path; the token never appears in
   logs.
2. **Auto-mint on user creation** *(operator-confirmed)*. `POST
   /api/admin/users` mints a token and stores it with the row, so every user
   has a working URL immediately. Pre-M6 rows are `NULL`; the UI offers
   Generate, and `POST .../sub-token` mints or replaces. There is no write
   on a GET path.
3. **Mint format reuses the node-token shape**: 32 random bytes → base64url
   unpadded (43 chars, `/^[A-Za-z0-9_-]{43}$/`), drawn inside the handler
   (no module-scope entropy). Node tokens keep their own module because
   their rules (hash at rest, constant-time compare) differ; this token is
   looked up by a unique index, with 256 bits of entropy making
   timing/brute-force attacks moot.
4. **`/sub` never errors for token states** *(operator-confirmed)*: unknown,
   disabled, expired, no access, no config, no address ⇒ `200` with whatever
   body results (empty at worst). `404` exists only for a missing user on
   the admin surface. This is the done-when's "empty body rather than an
   error", generalized so a capability URL reveals nothing about whether a
   token exists.
5. **Payload format**: standard base64 (with padding, `+/=` alphabet) of
   `uri1\nuri2\n…`, no trailing newline. `encodeSubscription` encodes UTF-8
   bytes via `TextEncoder` + the existing `bytesToBase64`, so a Unicode node
   address can never make `btoa` throw.
6. **Headers**: `Content-Type: text/plain; charset=utf-8`,
   `Cache-Control: no-store` (also on the rotation response). No
   `Subscription-Userinfo` (traffic totals are M7), no `Content-Disposition`,
   no profile-title header.
7. **One aggregation, two presentations.** The admin links route and the
   subscription body are the same `linkService.userLinks` call. The admin
   route keeps its diagnostic status codes (`404`/`503`/`409`) and warning
   strings; `/sub` drops warnings (the body holds nothing but links) and
   skips unusable nodes silently.
8. **Entitlement = `status === "active" && expiring?`** where `expire ===
   null` or `expire === 0` means never, otherwise `expire > now` (plane
   clock, Unix seconds). A pure `isEntitled(user, at)` in `user_service`,
   unit-tested at the boundaries. Applied only by `/sub`; rendering and the
   admin links view are untouched.
9. **`sub_token` + `sub_token_created_at` ride on `UserOut`** (null for
   legacy rows), so the SPA needs no extra GET. `POST
   /api/admin/users/{username}/sub-token` returns `SubTokenOut`
   (`{username, sub_token, created_at}`) with `no-store`, `201` like the
   node token mint.
10. **The URL is built client-side**: `subscriptionUrl(window.location.origin,
    token)` → `<origin>/sub/<token>` (the Vite dev proxy already forwards
    `/sub` to `:8787`). Pure function, vitest-tested.
11. **Deterministic order**: access rows node-id-ordered (existing
    `db.listAccessForUser`), each node's links sorted `(inbound, outbound,
    profile)` by the existing link service — the same order the admin list
    shows, so the two are byte-comparable and the body is diffable across
    syncs.

## Migration

`migrations/0004_sub_tokens.sql`:

```sql
-- M6: end-user subscription capability tokens.
--
-- The token is stored as plaintext, unlike nodes.token_hash, because the
-- subscription URL must stay re-displayable (it is the user's property and
-- admins re-copy it). A dump already exposes every UUID in
-- user_node_access, so hashing this adds no protection; rotation is the
-- revocation path. Rotation replaces the row value and invalidates the old
-- URL immediately.
ALTER TABLE users ADD COLUMN sub_token TEXT;
ALTER TABLE users ADD COLUMN sub_token_created_at INTEGER;

-- SQLite unique indexes treat NULLs as distinct, so pre-M6 rows (NULL)
-- coexist; the index both enforces uniqueness and serves the token lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sub_token ON users (sub_token);
```

## Target module map

### Backend — new

| File | Job |
|---|---|
| `migrations/0004_sub_tokens.sql` | the two columns + unique index |
| `src/services/subscription_service.ts` | pure `encodeSubscription`; async `subscriptionBody(env, token)` (lookup → entitlement → shared aggregation → base64) |
| `src/routers/sub.ts` | `GET /sub/:token` → `text/plain`, `no-store` |

### Backend — adapted

| File | Change |
|---|---|
| `src/db.ts` | `UserRow` gains the two fields; `createUser` stores them; new `setSubToken` and `getUserBySubToken` |
| `src/services/user_service.ts` | `mintSubToken`, `isEntitled`, auto-mint in `createUser`, `rotateSubToken`; export `nowSeconds` |
| `src/services/link_service.ts` | owns the cross-node aggregation: `userLinks(env, username, status)` returning `{links, warnings, accessCount, withConfigCount, addressableCount}`, plus the moved helpers and the exported `LinkOut` type |
| `src/routers/admin_users.ts` | links route delegates to `linkService.userLinks` and maps counts to the same 404/503/409; new `POST .../sub-token` |
| `src/models.ts` | `UserOut` + `sub_token`/`sub_token_created_at`; new `SubTokenOut` |
| `src/main.ts` | register `subRouter` |

### Backend — deliberately unchanged

`PROTOCOL.md`, `src/routers/node.ts`, `src/route_groups.ts` (the `/sub/`
prefix and its 404 semantics are already in place and tested),
`src/services/render_service.ts`, `qualify_service.ts`, `share_service.ts`,
`key_cipher.ts`, the migration files 0001–0003.

### Frontend — new

| File | Job |
|---|---|
| `frontend/src/lib/subscription.ts` | pure `subscriptionUrl(origin, token)` |
| `frontend/src/lib/subscription.test.ts` | vitest: origin handling, null token |
| `frontend/src/components/SubscriptionCard.tsx` | URL, copy, QR, created-at, Rotate / Generate, disabled/expired hint |

### Frontend — adapted

| File | Change |
|---|---|
| `frontend/src/types.ts` | `UserOut` gains the two fields; `SubTokenOut` |
| `frontend/src/api.ts` | `rotateSubToken(username)` |
| `frontend/src/components/ShareLinksDialog.tsx` | `SubscriptionCard` at the top, above warnings and links |
| `frontend/src/pages/UserEditPage.tsx` | `SubscriptionCard` in edit mode (buttons are already `type="button"`, so the form is unaffected) |
| `frontend/src/lib/access.test.ts` | `user()` fixture gains `sub_token: null`, `sub_token_created_at: null` |

### Tests

| File | Change |
|---|---|
| `tests/workerd/subscriptions.test.ts` | new — the seven criteria |
| `tests/pure/user_service.test.ts` | new — `isEntitled` boundaries, `mintSubToken` shape |
| `tests/pure/subscription_service.test.ts` | new — `encodeSubscription` (empty, join, padding, UTF-8) |
| `tests/pure/route_groups.test.ts` | unchanged — already covers `/sub/sometoken` |
| `tests/workerd/admin_users.test.ts`, `link_profiles.test.ts`, `two_nodes.test.ts` | unchanged — the harness for the refactor (criterion 7) |

### Docs

| File | Change |
|---|---|
| `docs/M6-PLAN.md` | this plan (Step 0); outcome section at closeout |
| `ARCHITECTURE.md` | subscriptions subsection, `users` data-model row, end-user trust-boundary paragraph, SPA card sentence |
| `PLAN.md` | M6 row + status paragraph |
| `docs/DEPLOY.md` | subscription smoke checks (the `/sub/*` bypass is already configured) |
| `AGENTS.md`, `README.md` | only if a stable statement goes stale; the four route groups and three auth tiers already say the right thing, so likely no edit |

## Execution plan

Each step is a reviewable unit: code + tests + the docs it invalidates, green
together. Read every touched file before moving on.

### Step 0 — Land this plan

Files: `docs/M6-PLAN.md`; `PLAN.md` (M6 row → in progress).

Work: commit the plan so the milestone's decisions are reviewable before
code.

Verify: markdown only.

### Step 1 — Schema and db accessors

Files: `migrations/0004_sub_tokens.sql`, `src/db.ts`.

Work:

- The migration above, with its rationale comment.
- `UserRow` gains `sub_token: string | null` and
  `sub_token_created_at: number | null`; `select *` readers pick them up
  with no query change.
- `createUser`'s object gains both fields and the INSERT gains both columns
  (the nullability exists only because the column is).
- `setSubToken(db, username, token, createdAt)` — one `UPDATE`, same
  "complete values, one fixed statement" style as `setTokenHash`.
- `getUserBySubToken(db, token)` — `SELECT * FROM users WHERE sub_token = ?`,
  null when missing; docstring notes the lookup rides the unique index and
  that a token is high-entropy, so no constant-time compare is needed
  (unlike the node token's header compare).
- `replaceUser` untouched, so a profile edit can never clobber a token.

Verify:

```powershell
npm test          # setup applies 0004 to the test D1; db/admin tests stay green
npm run typecheck
```

### Step 2 — User service: mint, entitlement, rotation

Files: `src/services/user_service.ts`, `tests/pure/user_service.test.ts`.

Work:

- `mintSubToken(): string` —
  `base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))`; docstring
  states the 256-bit/URL-safe reasoning and why the node-token module's
  hash/compare rules do not apply.
- `isEntitled(user: {status, expire}, at): boolean` — active and (`expire`
  null, `0`, or `> at`). `0` means never (matching `fmtExpire`'s existing
  convention); `expire === at` means expired.
- `createUser` mints and stores the token + `nowSeconds()`.
- `rotateSubToken(conn, username)` → `SubTokenOut | null` (null = user
  missing); mints, `setSubToken`, returns.
- Export `nowSeconds` (the plane's clock helper) for
  `subscription_service`.

Verify: `npm test`.

### Step 3 — Move the cross-node aggregation into `link_service`

Files: `src/services/link_service.ts`, `src/routers/admin_users.ts`.

Work: move `accessPairs`, `splitConfigPairs`, `addressableEntries`,
`unaddressableWarnings`, and `collectLinks` out of the router (they are
policy, not HTTP) behind one export:

```ts
export type LinkOut = ShareLink & { node: string };

export type UserLinks = {
  links: LinkOut[];
  warnings: string[];
  accessCount: number;       // access rows on the user
  withConfigCount: number;   // rows whose node has a config
  addressableCount: number;  // config-bearing nodes that can produce links
};
export async function userLinks(env, username, status): Promise<UserLinks>
```

Warning order is preserved exactly: skipped-config warnings (in access-row
order), then per-node link warnings prefixed `${node}: `, then unaddressable
warnings. The admin router keeps its four-line mapping (`accessCount > 0 &&
withConfigCount === 0` → 503; `withConfigCount > 0 && addressableCount ===
0` → 409) and the same response object.

Verify: `npm test`. **If any existing test needs an edit, the refactor
changed behavior — stop and fix the refactor, not the test.**

### Step 4 — Subscription service, sub router, models

Files: `src/services/subscription_service.ts`, `src/routers/sub.ts`,
`src/main.ts`, `src/models.ts`, `tests/pure/subscription_service.test.ts`.

Work:

- `encodeSubscription(uris: string[]): string` — pure;
  `bytesToBase64(new TextEncoder().encode(uris.join("\n")))`; `[]` yields
  `""` naturally.
- `subscriptionBody(env, token): Promise<string>` — empty token → `""`; user
  lookup → `""` when absent; `!isEntitled` → `""`; else `userLinks` and
  encode `links.map(l => l.uri)`. Docstring: leniency is the contract (a
  client is not an admin; there is no diagnostic surface here), and warnings
  stay admin-side.
- `routers/sub.ts`: `sub.get("/sub/:token", …)` → `c.body(body, 200, {
  "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })`.
  Only GET; extra path segments don't match; the route guard already admits
  the prefix.
- `main.ts`: import and `app.route("/", subRouter)`.
- `models.ts`: `UserOut` gains `sub_token: z.string().nullable()` and
  `sub_token_created_at: z.int().nullable()`; `SubTokenOut` added.
  `getUserWithAccess` already spreads the row, so responses carry them with
  no service change.
- Pure tests: empty list; two URIs round-trip through `atob` +
  `TextDecoder` to `u1\nu2` (no trailing newline); padded standard alphabet
  (`+`/`/` not `-`/`_`); a non-ASCII URI encodes as UTF-8.

Verify:

```powershell
npm test
npm run typecheck
```

### Step 5 — Admin rotation endpoint

Files: `src/routers/admin_users.ts`.

Work: `POST /api/admin/users/:username/sub-token` →
`userService.rotateSubToken`; null → `404 "user not found"`; else `201` +
`Cache-Control: no-store` with `SubTokenOut`. Docstring: rotation replaces
the value in one statement, so the old URL dies immediately — same posture
as the node token, but displayed (not hashed) because the URL is the
product.

Verify: `npm test`; the endpoint's cases land in Step 6.

### Step 6 — The workerd proof: `tests/workerd/subscriptions.test.ts`

Helpers mirror `admin_users.test.ts` (`makeNode(id, address, config)`,
`makeUser(username, access)`, `adminLinks(username)`, `subGet(token)` via
`planeFetch`, `decode(body)` = `atob` → uppercase→[]). Cases:

1. **Auto-mint and rotate** — create → `sub_token` matches
   `/^[A-Za-z0-9_-]{43}$/` and `sub_token_created_at > 0`; GET user matches;
   `POST .../sub-token` → 201, different token, `no-store`; old URL →
   `200 ""`; new URL → links; unknown user → 404.
2. **Body equals the admin link list** — node + config + user;
   `decode(body)` deep-equals the admin `links.map(l => l.uri)`;
   `content-type` and `cache-control` pinned.
3. **One node's address per link** — nodes A/B with different addresses and
   exits; one user on both; A's decoded URIs contain `a.example.com` and not
   `b.example.com`, and vice versa; count equals the admin endpoint's.
4. **Enrichment without URL change (criterion 5)** — user on A only; capture
   `url` and `decode`; PUT access to include B; assert token identical (the
   URL string cannot change), every old URI still present, B's URIs added,
   body longer.
5. **Disabled/expired are empty, recovery is silent** — disabled → `""`;
   past expiry → `""`; future expiry → links; `expire: 0` → links
   (never-expiry); disable again → `""`; token unchanged throughout.
6. **Unknown/rotated tokens** — `/sub/<random>`, `/sub/<rotated-away>` →
   200, `""`, `text/plain`, `no-store`; `/sub/` and `/sub/x/y` → 404 (route
   shape stays fail-closed); `POST /sub/<valid>` → 404.
7. **Unusable nodes are skipped silently** — a node without config and a
   node with config but no address contribute nothing and cause no error; a
   user with access but no usable node → `""`.
8. **No cross-user leakage** — two users on one node; each body contains
   only its own UUID/email.

Verify:

```powershell
npm test                    # new file + the whole existing suite
npm run typecheck
```

Run twice in a row (shared D1, `uid()`-scoped data).

### Step 7 — Frontend

Files: `frontend/src/types.ts`, `api.ts`, `lib/subscription.ts` (+test),
`components/SubscriptionCard.tsx`, `ShareLinksDialog.tsx`,
`UserEditPage.tsx`, `lib/access.test.ts`.

Work:

- Types and client wrapper; `rotateSubToken`.
- `subscriptionUrl(origin, token)`: `null`/empty token → `null`; else
  `<origin without trailing slash>/sub/<token>`.
- `SubscriptionCard({ username })`: self-fetching (docstring: the card owns
  its token state so both the dialog and the edit page get rotation for
  free), renders the URL, `CopyButton`, QR toggle (`QRCodeSVG`), created-at
  via `fmtTimestamp`, a hint that disabled/expired users receive an empty
  list, and Rotate (confirm: existing client URLs stop working immediately)
  or Generate when the token is null. Never logged, never stored.
- Wire into `ShareLinksDialog` (top) and `UserEditPage` (edit mode, inside
  the form but after the access sections; all its controls are
  `type="button"`).
- Update the `access.test.ts` fixture.

Verify:

```powershell
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

Manual (dev, if workerd boots on this machine): open Share → URL present →
copy → QR → rotate → old URL empty via curl, new URL works; disabled user →
empty; browser refresh of `/admin/users/<u>` keeps working. If the M5 TLS
boot issue recurs, the asset/API tiers carry the proof and the walkthrough
is recorded as an operator step.

### Step 8 — Docs, deploy, acceptance, closeout

Files: `ARCHITECTURE.md`, `PLAN.md`, `docs/DEPLOY.md`, `docs/M6-PLAN.md`.

Work:

- `ARCHITECTURE.md`: replace the placeholder sentence in "Links, link
  profiles, and subscriptions" with a Subscriptions subsection (token, URL,
  shared aggregation, format, empty-body states, rotation, per-node
  addresses, entitlement including `expire = 0`); add `sub_token` to the
  `users` data-model row; update the end-user trust-boundary paragraph
  (plaintext-at-rest rationale, rotation, `no-store`); mention the card in
  the SPA section.
- `PLAN.md`: M6 row → done; status paragraph after the TS rewrite paragraph
  (test file, what shipped, the operator-run real-client import item).
- `docs/DEPLOY.md`: smoke additions — apply migration 0004 before deploy
  (already the file's rule), then after deploy:

  ```powershell
  curl.exe -i https://cp.example.org/sub/<token>     # 200 text/plain (NOT a login redirect)
  # decode: [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((curl.exe -s ...)))
  curl.exe -i https://cp.example.org/sub/nope        # 200 empty
  ```

  plus "rotate → old URL empty immediately" and "disable → empty" checks;
  note the real-client import (v2rayN/NekoBox) as the operator acceptance
  step, like M4/M5's deferred machine steps.
- `docs/M6-PLAN.md`: fill the Outcome section with deviations (as M5 did).

Verify (final):

```powershell
npm test
npm run typecheck
npm run build
npm --prefix frontend test
npm --prefix frontend run build
npx wrangler d1 migrations apply <d1-database-name> --local
npx wrangler d1 migrations apply <d1-database-name> --remote   # then deploy + smoke
```

## Test inventory

| File | Origin | Coverage |
|---|---|---|
| `tests/workerd/subscriptions.test.ts` | new | all seven criteria: minting, rotation, encoding parity, per-node addresses, enrichment, entitlement, unknown tokens, skip rules, isolation, route shape |
| `tests/pure/user_service.test.ts` | new | `isEntitled` boundaries (null/0/past/future/now, disabled), `mintSubToken` shape and uniqueness |
| `tests/pure/subscription_service.test.ts` | new | `encodeSubscription`: empty, newline join, padding/alphabet, UTF-8 |
| `frontend/src/lib/subscription.test.ts` | new | URL construction, null token |
| rest of the suite | unchanged | must stay green with no edits (the refactor's gate) |

## Out of scope (do not build now)

`Subscription-Userinfo` / traffic totals (M7); quota enforcement (M8);
multiple tokens per user, per-token metadata, or revocation history; a
human-readable HTML page for browser hits; Access changes (the `/sub/*`
bypass is already live); `PROTOCOL.md` (stays frozen); agent changes of any
kind; rate limiting (no infrastructure for it); a bulk fleet endpoint; node
deletion; subscription analytics.

## Risks and gotchas

- **Apply 0004 before deploying.** The app selects `*`; a Worker deployed
  first turns every user query into a 500. `DEPLOY.md` already states the
  rule; the plan keeps it explicit.
- **The aggregation refactor is the risky step.** Warning order, per-node
  prefixes, and the 503/409 mapping are the observable contract; the
  existing tests are the gate and must not be edited to accommodate the
  move.
- **`expire === 0` means never**, not "expired at the epoch". Getting this
  wrong silently empties every legacy user's subscription.
- **`btoa` is Latin-1 only.** Encode UTF-8 bytes first; a Unicode `address`
  must not be able to break a whole subscription body.
- **Empty base64 is an empty string.** `200` + `Content-Length: 0` is the
  contract; some clients may treat it as retryable, which is acceptable —
  rotation and disablement are meant to be silent.
- **The body carries nothing but links.** No warnings, no headers-to-come,
  no JSON envelope.
- **The token is a secret in a body.** The rotation response is `no-store`;
  the sub response is `no-store`; never log the path or the token.
- **One extra aggregation per client refresh** (per-node key unseal + URI
  assembly). Fine at this scale and always fresh; an ETag/cache is a later
  change if a client fleet ever makes it hurt.
- **NULLs in a unique index** are fine in SQLite, but verify 0004 applies
  cleanly to a populated local D1 before trusting it.
- **The SPA builds the URL from `window.location.origin`**; this works in
  dev only because `vite.config.ts` already proxies `/sub`. Keep that line
  in mind if the proxy is ever touched.
