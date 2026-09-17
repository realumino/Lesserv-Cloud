"""Local-only migration runner: applies `migrations/*.sql` to a SQLite conn.

Why this exists: `migrations/*.sql` must be the single source of schema
truth so that M4's "migrations apply cleanly to a fresh D1" is automatic —
D1 gets them from wrangler, the local SQLite backend needs this small
runner so dev and tests build the same schema from the same files.

Why local-only: it reads the filesystem, which the Worker runtime does not
have. Like everything under `src/` it ships in the Worker bundle, but it is
never imported by `main.py`/`worker.py`, so workerd never executes it
(M0 finding 8: ship everything, run what the runtime allows).
"""

import time
from pathlib import Path


def split_statements(sql_text: str) -> list[str]:
    """Split one migration file into individual SQL statements.

    Why statement-at-a-time: the conn interface runs exactly one statement
    per execute (SQLite refuses multi-statement strings, and D1 has no
    equivalent). `--` line comments are stripped first; the DDL in this
    repo never puts a semicolon inside a string literal.
    """
    lines = [
        line for line in sql_text.splitlines()
        if not line.lstrip().startswith("--")
    ]
    return [
        statement.strip()
        for statement in "\n".join(lines).split(";")
        if statement.strip()
    ]


async def applied_migrations(conn) -> set[str]:
    """Return the set of migration filenames already recorded as applied."""
    await conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "  name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
    )
    rows = await conn.execute("SELECT name FROM schema_migrations")
    return {row["name"] for row in rows}


async def apply_migrations(conn, migrations_dir) -> list[str]:
    """Apply every unapplied migration, in filename order; return applied names.

    Why filename order: wrangler's D1 runner uses the same lexicographic
    order over the same directory, so the local schema always matches what
    a fresh D1 would build. Re-running is a no-op for already-applied
    files, which is what makes every process startup safe.
    """
    applied = await applied_migrations(conn)
    ran = []
    for path in sorted(Path(migrations_dir).glob("*.sql")):
        if path.name in applied:
            continue
        sql_text = path.read_text(encoding="utf-8")
        for statement in split_statements(sql_text):
            await conn.execute(statement)
        await conn.execute(
            "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
            (path.name, int(time.time())),
        )
        ran.append(path.name)
    return ran
