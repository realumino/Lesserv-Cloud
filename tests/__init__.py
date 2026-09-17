"""Make the spike's flat import root (`src/`) visible to unittest discovery.

Why this shim: under workerd the import root is the directory containing
the main module (`src/`), so application code uses flat imports like
`from core.x25519 import ...`. Tests run from the repo root, where those
names do not resolve; this adds `src/` to sys.path once, when the test
package is imported, so the copied test files need only their import
lines adapted and nothing else.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
