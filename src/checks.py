"""Platform checks: the evidence-gathering functions behind the spike route.

Why these live outside the router: the same functions must run under both
runtimes (locally under TestClient with SQLite, in workerd with D1 and
WebCrypto), so they take a conn argument and return plain dicts. The M0
verdict is literally the output of `run_all` from both runtimes.

These functions are async only where they await a conn or WebCrypto; the
pure checks (x25519, allocator) stay synchronous per the project rule.
"""

from core import allocator, x25519


def check_x25519() -> dict:
    """Run the RFC 7748 vectors and Xray-format key checks in this runtime.

    Why these specific vectors: they are the same assertions as
    tests/test_x25519.py, so a pass here means the copied module runs
    *unmodified* under Pyodide — that is M0 criterion (b), not just
    "Python works".
    """
    import base64

    failures = []

    # RFC 7748 §6.1 test vectors, hex in / base64url out.
    vectors = [
        (
            "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
        ),
        (
            "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
            "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
        ),
    ]
    for priv_hex, pub_hex in vectors:
        got = x25519.public_key_from_raw(bytes.fromhex(priv_hex))
        want = base64.urlsafe_b64encode(bytes.fromhex(pub_hex)).decode().rstrip("=")
        if got != want:
            failures.append("vector %s...: got %s" % (priv_hex[:8], got))

    # Generated keys must be Xray-format, clamped, and unique.
    # This is also the os.urandom-at-request-time probe: Cloudflare poisons
    # the PRNG at import/snapshot time, so this passing inside a route is
    # the evidence that key generation works at request time.
    try:
        k1, k2 = x25519.generate_private_key(), x25519.generate_private_key()
        raw = base64.urlsafe_b64decode(k1 + "=" * (-len(k1) % 4))
        if len(raw) != 32:
            failures.append("generated key is not 32 bytes")
        if not (raw[0] & 248 == raw[0] and raw[31] & 127 == raw[31] and raw[31] | 64 == raw[31]):
            failures.append("generated key is not clamped")
        if k1 == k2:
            failures.append("generated keys collide")
        if not x25519.derive_public_key(k1):
            failures.append("generated key does not derive")
    except Exception as exc:  # noqa: BLE001 - the check must report, not crash
        failures.append("generate_private_key raised: %r" % exc)

    if x25519.derive_public_key("not-base64!!!") is not None:
        failures.append("invalid key did not return None")

    return {"name": "x25519_rfc7748", "ok": not failures, "failures": failures}


def check_allocator() -> dict:
    """Run an allocate() fixture and compare against known-good output.

    Why a fixture instead of the full test suite: one representative
    allocation (two users, one vless inbound, one non-vless skip) proves
    the module executes under Pyodide; the exhaustive cases stay in the
    copied unittest file.
    """
    clients, rules, warnings = allocator.allocate(
        user_permissions={
            # alice holds both inbounds so the non-vless skip fires; bob has
            # no uuid so the missing-uuid warning fires before the inbound
            # loop ever runs (that ordering is the point of this fixture).
            "alice": {"allowed_inbounds": ["reality", "http"], "allowed_outbounds": ["niigata"]},
            "bob": {"allowed_inbounds": ["http"], "allowed_outbounds": ["niigata"]},
        },
        inbounds=[
            {"tag": "reality", "protocol": "vless"},
            {"tag": "http", "protocol": "http"},
        ],
        outbound_tags=["niigata"],
        uuids={"alice@niigata": "uuid-a"},
    )
    ok = (
        clients == {"reality": [{"id": "uuid-a", "email": "alice@niigata"}]}
        and rules == [{"user": ["regexp:.*@niigata$"], "outboundTag": "niigata"}]
        and len(warnings) == 2  # missing bob uuid + skipped non-vless inbound
    )
    return {"name": "allocator", "ok": ok, "failures": [] if ok else [str(clients), str(rules), str(warnings)]}


async def check_db_roundtrip(conn) -> dict:
    """Write, read back, and delete one row through the conn interface.

    Why the whole lifecycle: insert alone does not prove a round-trip.
    Reading back the exact value — including a unicode string and the
    JSON-text shape the real tables use — is criterion (c).
    """
    import json

    failures = []
    try:
        payload = json.dumps({"hello": ["мир", "世界"], "n": 42})
        await conn.execute(
            "INSERT INTO spike_kv (k, v) VALUES (?, ?) "
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            ("roundtrip", payload),
        )
        rows = await conn.execute("SELECT v FROM spike_kv WHERE k = ?", ("roundtrip",))
        if not rows or rows[0]["v"] != payload:
            failures.append("read-back mismatch: %r" % (rows,))
        await conn.execute("DELETE FROM spike_kv WHERE k = ?", ("roundtrip",))
        after = await conn.execute("SELECT v FROM spike_kv WHERE k = ?", ("roundtrip",))
        if after:
            failures.append("delete did not take effect")
    except Exception as exc:  # noqa: BLE001
        failures.append("raised: %r" % exc)
    return {"name": "db_roundtrip", "ok": not failures, "failures": failures}


async def check_crypto(conn, key_bytes: bytes) -> dict:
    """Encrypt, store in the DB, read back, decrypt, and verify tamper rejection.

    Why it goes through the DB: criterion (d) is not "WebCrypto works" but
    "the ciphertext round-trips through D1 in the v1: storage format" —
    the exact path reality_keys will use.
    """
    from crypto import decrypt, encrypt

    failures = []
    try:
        # Probe the platform first: under CPython there is no `js` module,
        # so the check must report `skipped` rather than a confusing
        # "raised ModuleNotFoundError" failure.
        from js import crypto as _js_crypto  # noqa: F401 - availability probe

        del _js_crypto
    except ModuleNotFoundError:
        return {
            "name": "aes_gcm_d1_roundtrip",
            "ok": False,
            "failures": ["skipped: no WebCrypto outside workerd"],
        }
    try:
        plaintext = b"realify-me: a REALITY private key would go here \xf0\x9f\x94\x91"
        stored = await encrypt(key_bytes, plaintext)
        if not stored.startswith("v1:"):
            failures.append("missing v1 prefix")
        await conn.execute(
            "INSERT INTO spike_kv (k, v) VALUES (?, ?) "
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            ("crypto", stored),
        )
        rows = await conn.execute("SELECT v FROM spike_kv WHERE k = ?", ("crypto",))
        roundtripped = rows[0]["v"]
        if await decrypt(key_bytes, roundtripped) != plaintext:
            failures.append("decrypt(encrypt(x)) != x after DB round-trip")
        wrong_key = bytes(range(32))
        try:
            await decrypt(wrong_key, roundtripped)
            failures.append("wrong key was accepted (GCM auth failed silently)")
        except Exception:
            pass  # expected: WebCrypto must reject a wrong key
        await conn.execute("DELETE FROM spike_kv WHERE k = ?", ("crypto",))
    except Exception as exc:  # noqa: BLE001
        failures.append("raised: %r" % exc)
    return {"name": "aes_gcm_d1_roundtrip", "ok": not failures, "failures": failures}


async def run_all(conn, key_bytes: bytes) -> dict:
    """Run every check and return the summary the spike route serves.

    Why a single entrypoint: one request against `pywrangler dev` produces
    the entire Worker-runtime evidence table for the M0 verdict.
    """
    checks = [
        check_x25519(),
        check_allocator(),
        await check_db_roundtrip(conn),
        await check_crypto(conn, key_bytes),
    ]
    return {
        "ok": all(c["ok"] for c in checks),
        "checks": {c["name"]: {"ok": c["ok"], "failures": c["failures"]} for c in checks},
    }
