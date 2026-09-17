"""The four route groups and the fail-closed path check.

Why this exists: the trust boundary is the set of path prefixes, and the
rule in AGENTS.md is that anything outside the four groups must 404 —
fail closed, never fail open. A middleware consults this module before
any routing happens, so a route registered at a wrong path (a leftover, a
typo) stays unreachable instead of exposed. Cloudflare Access (M4) is the
actual authentication for `/api/admin/*`; this guard is the in-app
guarantee that no route lives outside a group in the first place.
"""

PREFIXES = ("/api/admin/", "/api/node/", "/sub/")
HEALTH_PATH = "/api/health"


def is_allowed_path(path: str) -> bool:
    """Return True only for paths inside the four route groups.

    Why exact prefixes with a trailing slash: a bare group root like
    `/api/admin` has no routes and must 404; and without the slash, a
    typo like `/api/adminx` would match. `/api/health` is the one exact
    path; `/api/health/anything` is not it.
    """
    if path == HEALTH_PATH:
        return True
    return any(path.startswith(prefix) for prefix in PREFIXES)
