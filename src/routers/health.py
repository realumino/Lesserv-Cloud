"""Health check route: the cheapest possible proof that the app is alive.

Why this is its own router: `/api/health` is one of the four permanent
route groups in AGENTS.md, so it exists in both runtimes from the first
commit and is the only route that never depends on a database.
"""

from fastapi import APIRouter

router = APIRouter(tags=["system"])


@router.get("/api/health")
def health():
    """Return a constant body; if this responds at all, the app is up."""
    return {"status": "ok"}
