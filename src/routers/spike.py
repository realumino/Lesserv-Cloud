"""Spike routes: temporary endpoints that serve the M0 verdict.

Why these exist: the Worker-runtime criteria (Pyodide vectors, D1, FFI
crypto) can only be observed from inside workerd, so a route is the
harness. This router is gated behind SPIKE_MODE and MUST BE DELETED at
the first commit of M1 — AGENTS.md allows exactly four route prefixes,
and an unauthenticated diagnostics route violates the fail-closed rule.
"""

import base64
import os

from fastapi import APIRouter, HTTPException, Request

from checks import run_all
from db import get_conn

router = APIRouter(tags=["spike"])


def _spike_enabled(request: Request) -> bool:
    """Return True only when the runtime explicitly opts into spike routes.

    Why a var and not a constant: fail-closed by default. The route must
    404 in any runtime that did not ask for it, so a leftover spike router
    can never silently ship to production.
    """
    env = request.scope.get("env")
    if env is not None and getattr(env, "SPIKE_MODE", None) == "1":
        return True
    return bool(os.environ.get("LESSERV_SPIKE") == "1")


def _spike_key() -> bytes:
    """Return the 32-byte AES key for the crypto check.

    Why an env var and not a secret binding: M0 is local-only. At M4 the
    real key becomes a Worker secret; reading it from the environment
    keeps this file unchanged when that happens. The default is the
    literal bytes '0123...31' — fine for a spike that never leaves dev.
    """
    raw = os.environ.get("LESSERV_SPIKE_AES_KEY", "0123456789abcdef0123456789abcdef")
    return raw.encode()[:32]


@router.get("/api/spike/self-check")
async def self_check(request: Request):
    """Run every platform check in whichever runtime received the request.

    Why one route for everything: a single curl against `pywrangler dev`
    produces the complete Worker-runtime evidence table for the verdict.
    """
    if not _spike_enabled(request):
        raise HTTPException(status_code=404, detail="not found")
    return await run_all(get_conn(request), _spike_key())
