"""Local-runtime settings, overridable via environment variables.

Why this exists: the same code runs on a dev machine (no Xray binary, no
runtime dir worth keeping) and on the one VPS where M1-M2 still run Xray
locally; environment variables let the operator adapt without editing
code. Only the stopgap local runtime needs settings — the node's authored
config lives in the database, and the archived `SERVER_ADDRESS` is gone:
share-link addresses come from `nodes.address`.
"""

import os

RUNTIME_DIR = os.environ.get("LESSERV_RUNTIME_DIR", "data/runtime")
XRAY_BINARY = os.environ.get("LESSERV_XRAY_BINARY", "xray")
