"""Shared FastAPI dependencies for the admin routers.

Why this lives in routers/ and not db.py: db.py must not know HTTP exists
(the layering rule), and FastAPI only recognizes a Request parameter
through its type annotation — an HTTP concern. This one wrapper keeps the
annotation at the boundary while db.get_conn stays duck-typed.
"""

from fastapi import Request

from db import get_conn


def conn(request: Request):
    """FastAPI dependency: resolve the backend-agnostic conn for this request.

    Why a wrapper instead of Depends(db.get_conn): the Request annotation
    is what tells FastAPI this parameter is the request object; keeping
    that annotation here means db.py imports nothing from the HTTP layer,
    while every router gets the same backend-agnostic conn.
    """
    return get_conn(request)
