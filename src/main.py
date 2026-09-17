"""The FastAPI application shared by both runtimes.

Why one app object: the whole M0 verdict hangs on the claim that the same
`app` runs under uvicorn (local dev, tests) and inside a Worker (workerd).
This module must therefore never import platform-specific things: no
`sqlite3`, no `js` module, no D1. Those live in `local.py` and `worker.py`,
which each import this `app` and attach what their runtime provides.
"""

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from route_groups import is_allowed_path
from routers import admin_nodes, admin_reality, admin_users, health


async def route_group_guard(request, call_next):
    """Reject any path outside the four route groups with a bare 404.

    Why middleware and not per-router checks: fail-closed must hold for
    routes that do not exist yet and for mistakes made later. One check
    in front of routing cannot be forgotten by a new router, and there is
    no way to satisfy it partially — the path either sits in a group or
    the request never reaches one.
    """
    if not is_allowed_path(request.url.path):
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    return await call_next(request)


def create_app() -> FastAPI:
    """Build the app object both entrypoints share.

    Why a factory instead of a bare module-level `app`: it keeps the
    import of this module side-effect free, which matters under Workers
    where the top-level scope runs at deploy time and gets snapshotted.

    Why docs/redoc/openapi are disabled: they are served at the root,
    outside the four groups, and the guard is fail-closed. If API docs
    are wanted later they must be mounted inside `/api/admin/` (M4).
    """
    app = FastAPI(
        title="Lesserv-Cloud",
        lifespan=None,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.middleware("http")(route_group_guard)
    app.include_router(health.router)
    app.include_router(admin_nodes.router)
    app.include_router(admin_users.router)
    app.include_router(admin_reality.router)
    return app


app = create_app()
