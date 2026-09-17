"""The FastAPI application shared by both runtimes.

Why one app object: the whole M0 verdict hangs on the claim that the same
`app` runs under uvicorn (local dev, tests) and inside a Worker (workerd).
This module must therefore never import platform-specific things: no
`sqlite3`, no `js` module, no D1. Those live in `local.py` and `worker.py`,
which each import this `app` and attach what their runtime provides.
"""

from fastapi import FastAPI

from routers import health, spike


def create_app() -> FastAPI:
    """Build the app object both entrypoints share.

    Why a factory instead of a bare module-level `app`: it keeps the
    import of this module side-effect free, which matters under Workers
    where the top-level scope runs at deploy time and gets snapshotted.
    """
    app = FastAPI(title="Lesserv-Cloud", lifespan=None)
    app.include_router(health.router)
    app.include_router(spike.router)
    return app


app = create_app()
