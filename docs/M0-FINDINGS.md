# M0-FINDINGS.md — the platform viability verdict

The deliverable of M0 is a verdict, not code. This file is the evidence
and the constraints that follow from it. Produced by the spike scaffold
(`src/`, `tests/`, `migrations/0001_spike.sql`), which stays as the base
M1 builds on.

## Verdict

**Go.** All five criteria from `PLAN.md` passed:

| # | Criterion | Result | Evidence |
|---|---|---|---|
| a | Same FastAPI `app` under uvicorn and in a Worker | **PASS** | `{"status":"ok"}` from `GET /api/health` on `:8000` (uvicorn) and `:8787` (`pywrangler dev`, workerd). One `app` object from `src/main.py:create_app()`; `src/local.py` and `src/worker.py` only attach what their runtime provides. |
| b | `x25519` + `allocator` unmodified under Pyodide | **PASS** | `check_x25519` runs the RFC 7748 §6.1 vectors plus generate/clamp/derive checks **inside workerd** — all green. Files copied byte-for-byte (SHA-256 verified) from the archived panel. |
| c | D1 row round-trips through `db.py` | **PASS** | `check_db_roundtrip`: unicode/JSON-text payload inserted, read back, deleted via the same `conn.execute()` interface both backends share. |
| d | AES-GCM via FFI + ciphertext round-trips through D1 | **PASS** | `check_crypto`: `v1:<base64(iv‖ct+tag)>` value stored in D1, read back, decrypted byte-identical; a wrong key is rejected by WebCrypto (GCM auth) — verified, not assumed. |
| e | TestClient suite passes locally | **PASS** | `uv run python -m unittest discover -s tests -t .` → 21/21, including the archived panel's pure-core tests and the TestClient tests against SQLite. |

## Environment (as measured)

| Tool | Version |
|---|---|
| uv | 0.12.10 (pywrangler needs ≥ 0.12.3) |
| pywrangler (workers-py) | 1.17.3 |
| wrangler (via npx) | 4.133.0 |
| Worker runtime Python | **3.14.2** (Pyodide `314.0.7`, selected by compatibility_date ≥ 2026-09-08) |
| Local venv Python | 3.14.7 |
| fastapi (resolved for both runtimes) | 0.141.1 (pydantic 2.12.5 + pydantic-core 2.41.5 vendored from the Pyodide index) |
| Worker bundle | 379 modules, **~8.6 MB** (of which vendored packages ~8.59 MB) — fits the 10 MB paid limit, but this is now the thing to watch when adding dependencies |

M0 ran **local-only** (`pywrangler dev` + local D1), per the PLAN.md rule
that M0–M3 involve zero Cloudflare. The deploy-time snapshot path is
therefore verified only by the constraints below, not by a deploy.

## Constraints discovered (these are binding for M1+)

1. **No entropy at import time.** Cloudflare poisons the PRNG before
   taking the deploy-time memory snapshot; an `os.urandom`/`uuid4` call
   in top-level scope fails the deployment. Everything entropy-bearing
   (`generate_private_key`, UUID minting) must happen inside request
   handlers. Guarded by `tests/test_import_hygiene.py`, which imports the
   app with all entropy sources patched to raise.
2. **The import root is `src/`** — the directory containing the entry
   module. wrangler auto-adds a `PythonModule` rule over `**/*.py`
   relative to `main`, so subdirectories (`core/`, `routers/`) import
   flat: `from core.x25519 import ...`. Locally, uvicorn needs
   `--app-dir src` to match, and tests get the same root via the shim in
   `tests/__init__.py`.
3. **`db.py` is async everywhere, including the SQLite backend.** D1 has
   no synchronous API; the local `SqliteConn` wraps `sqlite3` in the same
   awaited interface (`async def execute(sql, params) -> list[dict]`).
   This is what lets M4 change bodies without touching signatures.
   Consequence: routers are `async def` from M1.
4. **The DB handle comes from the request, not module state.** Locally it
   is attached to `app.state` by `local.py`'s lifespan; on Workers it is
   `request.scope["env"].DB`, where the ASGI bridge (`workers.asgi`)
   puts the bindings object. `db.get_conn(request)` resolves both, so no
   router knows which backend is live.
5. **FFI conversions are explicit.** M0 hit and fixed two failure modes:
   `bytes` → JS needs an explicit `Uint8Array` (bytes arrive as an
   unusable view), and a Python list reaches WebCrypto as a PyProxy —
   `importKey`'s `keyUsages` must be a real JS Array (`to_js([...])`).
   JS Promises await normally through Pyodide.
6. **D1 Python results are already plain Python.** `stmt.run().results`
   is a `list[dict]` without any `.to_py()` conversion — the `D1Conn`
   wrapper exists for interface symmetry, not marshalling.
7. **Both platform modules import from anywhere, but behave differently.**
   `import sqlite3` works under workerd (Pyodide ships it — the spike's
   `db.py` imports it at top level and boots), yet a SQLite file there is
   useless: the Worker filesystem is ephemeral and not shared between
   isolates. Symmetrically, `from js import ...` raises
   `ModuleNotFoundError` under CPython. So `js` imports stay
   function-local (see `crypto.py`), and SQLite stays strictly a local-
   runtime backend regardless of what imports.
8. **`local.py` gets bundled into the Worker** (everything under the
   import root is uploaded as modules). Harmless while it is never
   imported, but M1 should not put Worker-hostile code in `src/` on the
   assumption it never ships — it ships; it just must not run.

## Spike harness (temporary)

`GET /api/spike/self-check` (both runtimes, returns the evidence table
above) is gated behind `SPIKE_MODE=1` (wrangler vars) / `LESSERV_SPIKE=1`
(env, local) and 404s otherwise. It is an unauthenticated diagnostics
route — a fifth prefix outside the four route groups — so it **must be
deleted at the first commit of M1**, along with `migrations/0001_spike.sql`
and `src/checks.py`'s DB/crypto checks. `src/checks.py`'s pure checks
(x25519, allocator) can graduate into the copied test suite instead.

Commands used for the evidence:

```
uv run pywrangler dev                                    # workerd on :8787, local D1
npx wrangler d1 migrations apply lesserv --local         # spike table into local D1
uv run uvicorn local:app --app-dir src                   # same app on :8000, SQLite
curl http://127.0.0.1:8787/api/spike/self-check          # Worker-runtime evidence
curl http://127.0.0.1:8000/api/spike/self-check          # Local-runtime evidence
uv run python -m unittest discover -s tests -t . -v      # criterion (e)
```
