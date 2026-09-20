"""Black-box harness: one real plane under `pywrangler dev` + local D1.

WHY a live server: app code runs only inside workerd, so every test that
touches the database, bindings, or WebCrypto drives it over HTTP — the
same surface agents and admins use. The plane is started once per test
run against a throwaway `--persist-to` directory, so runs never share
state with each other or with a manually started dev server.

WHY unique ids instead of resets: one server serves the whole run
(booting costs ~30s), so every test names its own nodes and users and
asserts on what it created, never on global list contents.
"""

import atexit
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BOOT_TIMEOUT_S = 120
REQUEST_TIMEOUT_S = 60
D1_DATABASE = "lesserv"


def uid(prefix=""):
    """Return a unique lowercase alphanumeric id for one test's data.

    WHY random suffixes: the whole integration run shares one D1, so ids
    must not collide between tests (or between runs). Node ids must be
    1-32 chars of [a-z0-9] — no hyphens (models.py) — and hex is safe for
    usernames too.
    """
    return f"{prefix}{os.urandom(4).hex()}"


def d1_query(sql):
    """Run one read-only SQL statement against the plane's local D1.

    WHY a helper: a few invariants (keys are sealed at rest) can only be
    seen in the database. pywrangler forwards to wrangler, whose --json
    output is embedded after INFO lines; this extracts the JSON payload
    wherever it starts. The same --persist-to as the plane targets the
    same throwaway database.
    """
    persist = _plane().persist
    result = subprocess.run(
        ["uv", "run", "pywrangler", "d1", "execute", D1_DATABASE,
         "--local", "--persist-to", persist, "--json", "--command", sql],
        capture_output=True, text=True, timeout=120, cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"d1 execute failed: {result.stderr[-2000:]}")
    out = result.stdout
    start = out.find("[")
    if start < 0:
        raise RuntimeError(f"d1 execute returned no JSON: {out[-2000:]}")
    decoded, _ = json.JSONDecoder().raw_decode(out[start:])
    return decoded[0]["results"]


class Response:
    """One HTTP response, shaped like the TestClient responses tests know."""

    def __init__(self, status, body, headers):
        self.status_code = status
        self._body = body
        self.headers = {key.lower(): value for key, value in headers.items()}

    def json(self):
        return self._body

    @property
    def text(self):
        """The body as text, for assertion messages."""
        if self._body is None:
            return ""
        if isinstance(self._body, str):
            return self._body
        return json.dumps(self._body)


class Client:
    """JSON-over-HTTP client bound to one base URL.

    WHY it mimics TestClient: get/post/put/delete(path, json=..., ...)
    returning a response with status_code/json()/headers lets ported
    tests read exactly like the HTTP tests they were converted from.
    """

    def __init__(self, base=None):
        self.base = base or _plane().base

    def request(self, method, path, json_body=None, headers=None, params=None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
                return Response(resp.status, _parse(resp.read()), dict(resp.headers))
        except urllib.error.HTTPError as exc:
            body = exc.read()
            return Response(exc.code, _parse(body), dict(exc.headers))

    def get(self, path, headers=None, params=None):
        """GET one path."""
        return self.request("GET", path, headers=headers, params=params)

    def post(self, path, json=None, headers=None, params=None):
        """POST a JSON body."""
        return self.request("POST", path, json_body=json, headers=headers,
                            params=params)

    def put(self, path, json=None, headers=None, params=None):
        """PUT a JSON body."""
        return self.request("PUT", path, json_body=json, headers=headers,
                            params=params)

    def delete(self, path, json=None, headers=None, params=None):
        """DELETE one path."""
        return self.request("DELETE", path, json_body=json, headers=headers,
                            params=params)


def _parse(raw):
    """Decode a response body: JSON when it parses, else text, None if empty."""
    text = raw.decode("utf-8") if raw else ""
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def _free_port():
    """Return an ephemeral localhost port for the test plane."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def _kill_tree(pid):
    """Terminate a spawned process and everything it launched."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True)
    else:
        import signal
        os.killpg(os.getpgid(pid), signal.SIGKILL)


class Plane:
    """One pywrangler dev process with its own throwaway D1 directory."""

    def __init__(self):
        self.persist = tempfile.mkdtemp(prefix="lesserv-test-")
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.secret = base64.b64encode(os.urandom(32)).decode()
        self.log_path = os.path.join(self.persist, "plane.log")
        _ensure_assets()
        _apply_migrations(self.persist)
        self.proc = _start_server(self.persist, self.port, self.secret)
        atexit.register(self.stop)
        _wait_ready(self, self.base)

    def stop(self):
        """Kill the server tree and delete the throwaway directory."""
        if self.proc.poll() is None:
            _kill_tree(self.proc.pid)
        try:
            self.proc.wait(timeout=15)
        except Exception:
            pass
        if getattr(self.proc, "_log", None):
            self.proc._log.close()
        shutil.rmtree(self.persist, ignore_errors=True)


_STUB_INDEX = "<!doctype html><title>plane test stub</title>"


def _ensure_assets():
    """Write stub SPA indexes when frontend/dist is missing.

    WHY: the committed wrangler config points its assets directory at
    frontend/dist, which is gitignored and only exists after
    `npm --prefix frontend run build`. wrangler refuses to boot when that
    directory is absent, so a fresh clone could not run the workerd tier at
    all; the stubs satisfy the config without shipping built assets. Both
    the mirrored admin index (served at /admin/) and the root index (the
    SPA fallback target) are written, so the asset tests exercise the
    serving arrangement even before a real build. A real build overwrites
    them, and the tests never assert on SPA bytes.
    """
    dist = os.path.join(REPO_ROOT, "frontend", "dist")
    for index in (os.path.join(dist, "index.html"),
                  os.path.join(dist, "admin", "index.html")):
        if os.path.exists(index):
            continue
        os.makedirs(os.path.dirname(index), exist_ok=True)
        with open(index, "w", encoding="utf-8") as handle:
            handle.write(_STUB_INDEX)


def _apply_migrations(persist):
    """Create the schema in the throwaway D1 before the plane boots."""
    result = subprocess.run(
        ["uv", "run", "pywrangler", "d1", "migrations", "apply", D1_DATABASE,
         "--local", "--persist-to", persist],
        capture_output=True, text=True, timeout=180, cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "migrations apply failed:\n" + (result.stderr or result.stdout)[-2000:]
        )


def _start_server(persist, port, secret):
    """Spawn `pywrangler dev` bound to the throwaway directory and port.

    WHY --var for the secret: key_cipher requires REALITY_KEY_SECRET (no
    plaintext fallback exists), and a fresh random key per run keeps test
    ciphertext independent of any real deployment's .dev.vars.
    """
    log = open(os.path.join(persist, "plane.log"), "wb")
    proc = subprocess.Popen(
        ["uv", "run", "pywrangler", "dev", "--port", str(port),
         "--persist-to", persist, f"--var", f"REALITY_KEY_SECRET:{secret}"],
        cwd=REPO_ROOT, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=(sys.platform != "win32"),
    )
    proc._log = log
    return proc


def _wait_ready(plane, base):
    """Poll /api/health until the plane answers, or fail with its log."""
    deadline = time.time() + BOOT_TIMEOUT_S
    while time.time() < deadline:
        if plane.proc.poll() is not None:
            raise RuntimeError(
                "plane exited during boot (see plane.log):\n" + _log_tail(plane)
            )
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=5) as resp:
                if resp.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("plane did not boot in %ds:\n" % BOOT_TIMEOUT_S + _log_tail(plane))


def _log_tail(plane):
    """The last lines of the plane log, for failure messages."""
    try:
        with open(plane.log_path, "r", encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-15:])
    except Exception:
        return "(plane.log unreadable)"


_plane_instance = None


def _plane():
    """Start the plane on first use; every test shares it."""
    global _plane_instance
    if _plane_instance is None:
        _plane_instance = Plane()
    return _plane_instance


def client():
    """Return the shared HTTP client for the running plane."""
    return Client()
