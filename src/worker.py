"""Worker entrypoint: the same `app` inside workerd, backed by D1.

Why this file is separate from main.py: the Workers runtime executes the
entrypoint's top-level scope at deploy time and takes a memory snapshot,
so this module must stay side-effect free. `asgi.entrypoint` wires the
JS `Request` into the ASGI app and puts the bindings object on
`request.scope["env"]`, which the request dependency in db.py reads.
"""

from workers import asgi

from main import app

Default = asgi.entrypoint(app)
