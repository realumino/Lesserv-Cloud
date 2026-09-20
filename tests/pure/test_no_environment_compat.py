"""Enforce the one-runtime rule: src/ speaks workerd, nothing else.

WHY this test exists: after the compatibility purge, application code
must have zero environment-conditional imports — no `sqlite3`, no
`uvicorn`, no module-scope `js`/`workers` outside the Worker entrypoint.
Static scanning keeps the boundary from eroding one import at a time;
a module that needs bindings belongs to the workerd test tier, not to a
branch inside src/.
"""

import ast
import os
import unittest

SRC_ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "src",
)
# Module-scope imports that would drag in a foreign environment. `workers`
# is allowed in exactly one file: the Worker entrypoint.
_FORBIDDEN_MODULE_SCOPE = {"sqlite3", "uvicorn", "js", "workers"}
_ENTRYPOINT_ALLOWLIST = {"worker.py": {"workers"}}
_FORBIDDEN_ANYWHERE = {"local", "migrations"}


def _names(node):
    """The imported module names of one import statement."""
    if isinstance(node, ast.Import):
        return [alias.name.split(".")[0] for alias in node.names]
    return [node.module] if node.module else []


def _imports_outside_functions(tree):
    """Every import in the module or a class body, never inside a function.

    WHY functions are exempt: `from js import ...` and `from workers
    import ...` are legal lazily (crypto.py, key_cipher.py) — importing
    them raises under a plain interpreter, so the call must be deferred
    to request time. Module scope runs at deploy time and gets
    snapshotted, so that is where the rule bites.
    """

    def walk(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if isinstance(child, (ast.Import, ast.ImportFrom)):
                yield child
            yield from walk(child)

    yield from walk(tree)


class TestNoEnvironmentCompat(unittest.TestCase):
    """src/ runs under workerd only; nothing imports a second runtime."""

    def test_no_module_scope_environment_imports(self):
        offenders = []
        for root, _, files in os.walk(SRC_ROOT):
            for name in sorted(files):
                if not name.endswith(".py"):
                    continue
                path = os.path.join(root, name)
                rel = os.path.relpath(path, SRC_ROOT).replace("\\", "/")
                with open(path, "r", encoding="utf-8") as handle:
                    tree = ast.parse(handle.read())
                allowed = _ENTRYPOINT_ALLOWLIST.get(name, set())
                for node in _imports_outside_functions(tree):
                    for module in _names(node):
                        if module in _FORBIDDEN_ANYWHERE:
                            offenders.append(f"{rel}:{node.lineno} {module}")
                        elif (module in _FORBIDDEN_MODULE_SCOPE
                              and module not in allowed):
                            offenders.append(f"{rel}:{node.lineno} {module}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
