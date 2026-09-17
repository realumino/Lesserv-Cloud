"""Write the rendered runtime config and run local Xray (stopgap until M3).

Why this exists: through M2 the control plane is still one process with
Xray as a child, exactly like the archived panel ("still one process" in
PLAN.md). M3's agent split deletes this module and the sync calls. Only
the file/subprocess shell lives here — rendering is render_service's job —
so the deletion is clean and the render pipeline never changes.

Design rules kept from the archived panel on purpose:
- Nothing ever raises: a missing config or binary is an expected state on
  a dev machine, so every step logs a warning and gives up.
- The process handle is module-level (not app.state) because services have
  no access to the app object.
- start/stop hold a lock because sync runs from request handlers.
"""

import json
import logging
import os
import shutil
import subprocess
import threading

import settings
from services import render_service

logger = logging.getLogger(__name__)

_process = None
_lock = threading.Lock()


def runtime_path(node_id) -> str:
    """Return the runtime config path for one node.

    Why per node: each node's rendered artifact is its own file, so the
    runtime pane can show exactly what that node's local Xray received.
    """
    return os.path.join(settings.RUNTIME_DIR, f"{node_id}.json")


def write_runtime_config(node_id, config):
    """Atomically write one node's rendered config.

    Why temp file + os.replace: writing in place could hand Xray a
    half-written file on a crash; the replace is atomic on the same disk.
    """
    path = runtime_path(node_id)
    os.makedirs(settings.RUNTIME_DIR, exist_ok=True)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
    os.replace(tmp_path, path)


def load_runtime_config(node_id):
    """Read one node's rendered config; None when missing or invalid.

    Why None instead of raising: "not rendered yet" is a normal state —
    the runtime pane renders an empty state, not an error.
    """
    path = runtime_path(node_id)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        try:
            return json.load(handle)
        except json.JSONDecodeError:
            logger.warning("runtime config at %s is not valid JSON", path)
            return None


def runtime_mtime(node_id) -> int | None:
    """Return the runtime file's last-write time, or None when absent.

    Why here and not in the router: this module is the one place that
    touches the filesystem; the timestamp lets the UI tell "never
    generated" apart from a real timestamp.
    """
    path = runtime_path(node_id)
    if not os.path.exists(path):
        return None
    return int(os.path.getmtime(path))


def _binary_available() -> bool:
    """Return True when the Xray binary actually exists on this machine.

    Why both checks: the default "xray" must be found via PATH, but
    settings may also point at an absolute path that is simply not there.
    """
    return shutil.which(settings.XRAY_BINARY) is not None or os.path.exists(
        settings.XRAY_BINARY
    )


def start(path):
    """Launch Xray with one node's runtime config; warn-and-skip in dev.

    Why stdout/stderr are inherited: Xray's own log is the operator's
    debugging window. Why the 2-second early-exit check: Xray dies within
    moments when the config is invalid; without this the panel would
    believe it is running when it is not.
    """
    global _process
    with _lock:
        if _process is not None and _process.poll() is None:
            logger.warning(
                "Xray already running (pid %s); not starting again", _process.pid
            )
            return
        if not _binary_available():
            logger.warning(
                "Xray binary %r not found; skipping start (dev?)", settings.XRAY_BINARY
            )
            return
        _process = subprocess.Popen(
            [settings.XRAY_BINARY, "run", "-config", path]
        )
        try:
            _process.wait(timeout=2)
            logger.error(
                "Xray exited immediately with code %s; check %s",
                _process.returncode, path,
            )
            _process = None
        except subprocess.TimeoutExpired:
            logger.info("started Xray pid %s", _process.pid)


def stop():
    """Terminate the Xray subprocess; no-op when it is not running.

    Why terminate + wait: terminate asks politely; wait gives it a moment
    before kill. A zombie would hold the port and break the next start.
    """
    global _process
    with _lock:
        if _process is None or _process.poll() is not None:
            _process = None
            return
        _process.terminate()
        try:
            _process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            logger.warning("Xray did not exit within 5s; killing it")
            _process.kill()
        _process = None


def restart(node_id):
    """Stop then start on one node's runtime config.

    Why this exists: Xray reads its config only at startup, so every
    render that gets written must bounce the process. (No gRPC API in M1.)
    """
    stop()
    start(runtime_path(node_id))


def status() -> dict:
    """Return the Xray subprocess health without side effects.

    Why a read of the module-level reference: the status endpoint needs a
    snapshot of the process without touching the lock; a read of the
    reference is atomic in CPython.
    """
    proc = _process
    if proc is not None and proc.poll() is None:
        return {"running": True, "pid": proc.pid}
    return {"running": False, "pid": None}


async def sync_node(conn, node_id):
    """Render one node's desired config; write it and bounce local Xray.

    Why one entry point per node: every mutation funnels here so the local
    runtime converges after any change. Warnings are logged, never raised
    — a broken config must not take the API down. M3 replaces the
    write+bounce with the agent's pull.
    """
    runtime, warnings = await render_service.desired_config(conn, node_id)
    for warning in warnings:
        logger.warning("sync %s: %s", node_id, warning)
    if runtime is None:
        return
    write_runtime_config(node_id, runtime)
    restart(node_id)


async def sync_nodes(conn, node_ids):
    """Sync several nodes in the caller's order.

    Why a loop over sync_node: user edits touch several nodes at once
    (the access map's node ids); each node's render is independent, so
    plain sequential calls keep the code obvious.
    """
    for node_id in node_ids:
        await sync_node(conn, node_id)
