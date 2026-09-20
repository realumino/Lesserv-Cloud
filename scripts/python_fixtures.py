"""Generate the Python-oracle fixtures under tests/fixtures/.

WHY this script exists: the TS plane must reproduce Python's bytes for
canonical JSON, share URIs, and X25519 keys. Before the Python tree is
deleted, it is the oracle; this script runs the frozen Python modules and
writes their outputs as JSON fixtures the TS tests assert against.

WHY it is temporary: after the cutover there is no Python implementation to
regenerate from, so the fixtures stay and this script is deleted with the
rest of the Python tree.

Usage:
    uv run python scripts/python_fixtures.py           # regenerate
    uv run python scripts/python_fixtures.py --check   # fail if stale
"""

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from core import x25519  # noqa: E402  (path shim must run first)
from services import config_service, qualify_service, share_service  # noqa: E402

FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"

# The project's fixed test keypair (used across Python and TS tests).
FIXED_PRIVATE = "sMS4KcvOCag9dZsYPa3sFfVLSn3IGNEI34B7ENhGBFE"

# RFC 7748 §6.1 vectors: raw private scalar -> raw public u coordinate.
RFC7748 = [
    (
        "alice",
        "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
        "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
    ),
    (
        "bob",
        "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
        "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
    ),
]


def canonical(value):
    """Return Python's canonical JSON text for one value."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def build_python_json_fixture():
    """Return the canonical-JSON vectors, known limits, and a rendered hash."""
    vectors = [
        ("string with BMP and astral characters", "caf\u00e9 \U0001F600"),
        ("control characters", "\u0000\u0001\b\f\n\r\t\u001f"),
        ("quote and backslash", 'say "hi" \\ there'),
        ("DEL stays literal", "\u007f"),
        ("positive integer", 42),
        ("negative integer", -7),
        ("zero", 0),
        ("simple float", 0.1),
        ("negative float", -2.5),
        ("small exponent", 1e-05),
        ("large exponent", 1e21),
        ("fixed lower bound", 1e-04),
        ("shortest digits", 1.5e-07),
        ("negative zero float", -0.0),
        ("true", True),
        ("false", False),
        ("null", None),
        ("nested list", [1, [2, [3, None]], {"a": [True, False]}]),
        ("object key order", {"b": 1, "a": 2, "C": 3}),
        ("astral key before BMP in UTF-16 only", {"\U0001F600": 1, "\uFFFD": 2, "a": 3}),
        ("nested objects", {"z": {"y": [1, 2]}, "a": {"b": 3}}),
        ("empty containers", [[], {}, ""]),
    ]
    # `typescript` is the pinned TS-side output (V8 shortest-round-trip
    # stringification after JSON.parse); it is a record of the known limit,
    # not a value the Python oracle can produce.
    known_limits = [
        (
            "whole-number float",
            100.0,
            "100",
            "after JSON.parse the value is the integer 100; Python keeps the float form",
        ),
        (
            "whole-number float in fixed range",
            1e15,
            "1000000000000000",
            "same integer/float ambiguity as 100.0; only the pre-cutover audit can see stored occurrences",
        ),
        (
            "whole-number float at the exponent boundary",
            1e16,
            "10000000000000000",
            "Python repr switches to 1e+16 here, JS String() prints the full integer digits",
        ),
        (
            "integer beyond 2^53",
            12345678901234567890,
            "12345678901234567000",
            "JSON.parse rounds it to a double; Python ints are arbitrary precision",
        ),
    ]
    return {
        "vectors": [
            {"name": name, "value": value, "python": canonical(value)}
            for name, value in vectors
        ]
        # A lone surrogate cannot survive the JS toolchain's JSON import
        # (esbuild rejects the escape), so it travels as UTF-16 code units
        # and the test rebuilds the string.
        + [
            {
                "name": "lone surrogate",
                "value_units": [0xD800],
                "python": canonical("\ud800"),
            }
        ],
        "known_limits": [
            {
                "name": name,
                "value": value,
                "python": canonical(value),
                "typescript": typescript,
                "why": why,
            }
            for name, value, typescript, why in known_limits
        ],
        "rendered_config": rendered_config_fixture(),
    }


def rendered_config_fixture():
    """Render one realistic node with the Python pipeline and hash it.

    WHY the full pipeline: the hash is only meaningful over the exact shape
    `render_service` produces — qualified config, qualified users, injected
    REALITY key — so the fixture replays that sequence without touching the
    database.
    """
    authored = {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {
                "tag": "reality",
                "listen": "0.0.0.0",
                "port": 443,
                "protocol": "vless",
                "settings": {
                    "clients": [],
                    "decryption": "none",
                    "flow": "xtls-rprx-vision",
                },
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {
                        "target": "apple.com:443",
                        "serverNames": ["apple.com"],
                        "shortIds": ["1234"],
                        "privateKey": "placeholder",
                    },
                },
            },
            {
                "tag": "xhttp",
                "listen": "0.0.0.0",
                "port": 8080,
                "protocol": "vless",
                "settings": {"clients": [], "decryption": "none"},
                "streamSettings": {
                    "network": "xhttp",
                    "security": "none",
                    "xhttpSettings": {"path": "/x", "host": "cdn.example.com"},
                },
            },
        ],
        "outbounds": [
            {"tag": "japan", "protocol": "freedom"},
            {"tag": "BLOCK", "protocol": "blackhole"},
        ],
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "rules": [{"domain": ["example.com"], "outboundTag": "japan"}],
        },
    }
    users = [
        {
            "username": "alice",
            "status": "active",
            "allowed_inbounds": ["reality", "xhttp"],
            "allowed_outbounds": ["japan"],
            "uuids": {"alice@japan": "11111111-1111-1111-1111-111111111111"},
        },
        {
            "username": "bob",
            "status": "disabled",
            "allowed_inbounds": ["reality"],
            "allowed_outbounds": ["japan"],
            "uuids": {"bob@japan": "22222222-2222-2222-2222-222222222222"},
        },
    ]
    qualified_config = qualify_service.qualify_config(authored, "tokyo01")
    qualified_users = qualify_service.qualify_users(users, "tokyo01")
    qualified_keys = qualify_service.qualify_keys({"reality": FIXED_PRIVATE}, "tokyo01")
    runtime, warnings = config_service.build_config(qualified_config, qualified_users)
    warnings = warnings + config_service.apply_reality_keys(runtime, qualified_keys)
    canonical_text = canonical(runtime)
    return {
        "config": runtime,
        "warnings": warnings,
        "canonical": canonical_text,
        "sha256": hashlib.sha256(canonical_text.encode()).hexdigest(),
    }


def build_python_uri_fixture():
    """Return quote/urlencode vectors and the label fragment oracle."""
    from urllib.parse import quote, urlencode

    quote_inputs = [
        ("punctuation set", "a b!'()*~_-.", ""),
        ("non-ASCII BMP and astral", "caf\u00e9 \u00b7 \u2192 \U0001F600", ""),
        ("share label fragment", "Tokyo 01 \u00b7 XHTTP \u2192 Japan", ""),
        ("URI separators", "a/b?c=d&e", ""),
        ("percent and space", "100% done", ""),
        ("always-safe set", "AZaz09_.-~", ""),
        ("path with safe slash", "path/to?x", "/"),
    ]
    urlencode_inputs = [
        (
            "transport params",
            {
                "encryption": "none",
                "type": "xhttp",
                "path": "/xhttp-path",
                "host": "xhttp.example.com",
                "mode": "auto",
            },
        ),
        (
            "non-string values",
            {"n": 443, "b": True, "f": 1.5, "z": None},
        ),
        (
            "insertion order",
            {"z": "1", "a": "2", "m": "3"},
        ),
    ]
    return {
        "quote": [
            {"name": name, "text": text, "safe": safe, "python": quote(text, safe=safe)}
            for name, text, safe in quote_inputs
        ],
        "urlencode": [
            {
                "name": name,
                "params": params,
                "python": urlencode(params, quote_via=quote, safe=""),
            }
            for name, params in urlencode_inputs
        ],
        "labels": [
            {
                "remark": "Tokyo 01 \u00b7 XHTTP \u2192 Japan",
                "python": quote("Tokyo 01 \u00b7 XHTTP \u2192 Japan", safe=""),
            }
        ],
    }


def fixture_private_key(index):
    """Return one deterministic clamped private key for the fixtures.

    WHY deterministic: `generate_private_key` is random, so it cannot back a
    `--check`-able fixture. A fixed digest run through the module's own clamp
    yields the same shape (clamped scalar, base64url unpadded) with stable
    bytes.
    """
    digest = hashlib.sha256(f"lesserv-fixture-key-{index}".encode()).digest()
    scalar = x25519._clamp(digest)
    return base64.urlsafe_b64encode(scalar.to_bytes(32, "little")).decode().rstrip("=")


def build_x25519_fixture():
    """Return RFC vectors, the fixed keypair, and generated round-trips."""
    generated = []
    for index in range(8):
        private = fixture_private_key(index)
        generated.append(
            {"private": private, "public": x25519.derive_public_key(private)}
        )
    standard = FIXED_PRIVATE + "="
    return {
        "rfc7748": [
            {"name": name, "private_hex": private, "public_hex": public}
            for name, private, public in RFC7748
        ],
        "fixed": {
            "private": FIXED_PRIVATE,
            "public": x25519.derive_public_key(FIXED_PRIVATE),
        },
        "padded_variant": {"unpadded": FIXED_PRIVATE, "padded": standard},
        "generated": generated,
        "invalid": ["", "not-base64!!!", "aW52YWxpZA"],
    }


def build_node_token_fixture():
    """Return one deterministic token and its Python-computed SHA-256 hash.

    WHY deterministic: minting is random, so a fixed digest (in the same
    base64url-unpadded shape `token_urlsafe(32)` produces) is what backs a
    `--check`-able fixture. The TS `verifyToken` must accept this hash.
    """
    token_bytes = hashlib.sha256(b"lesserv-fixture-token").digest()
    token = base64.urlsafe_b64encode(token_bytes).decode().rstrip("=")
    return {"token": token, "sha256": hashlib.sha256(token.encode()).hexdigest()}


def share_config():
    """Return the config used by the share-link scenarios.

    WHY this shape: it exercises raw/reality, xhttp, ws, a wildcard listen,
    a non-VLESS inbound, and two exits — the same surface the Python share
    tests pin.
    """
    return {
        "inbounds": [
            {
                "tag": "REALITY_IN",
                "protocol": "vless",
                "listen": "0.0.0.0",
                "port": 443,
                "settings": {"flow": "xtls-rprx-vision"},
                "streamSettings": {
                    "network": "raw",
                    "security": "reality",
                    "realitySettings": {
                        "serverNames": ["apple.com"],
                        "privateKey": FIXED_PRIVATE,
                        "shortIds": ["1234"],
                    },
                },
            },
            {
                "tag": "XHTTP_IN",
                "protocol": "vless",
                "listen": "203.0.113.5",
                "port": 8080,
                "streamSettings": {
                    "network": "xhttp",
                    "xhttpSettings": {
                        "path": "/xhttp-path",
                        "host": "xhttp.example.com",
                        "mode": "auto",
                    },
                },
            },
            {
                "tag": "WS_IN",
                "protocol": "vless",
                "listen": "::",
                "port": 8443,
                "streamSettings": {
                    "network": "ws",
                    "wsSettings": {
                        "path": "/ws-path",
                        "host": "ws.example.com",
                    },
                },
            },
            {"tag": "HTTP_ONLY", "protocol": "http", "port": 80},
        ],
        "outbounds": [
            {"tag": "JAPAN", "protocol": "freedom"},
            {"tag": "HK", "protocol": "freedom"},
        ],
    }


def share_user(inbounds, outbounds):
    """Return one projected user with a uuid per allowed exit."""
    return {
        "username": "alice",
        "status": "active",
        "allowed_inbounds": inbounds,
        "allowed_outbounds": outbounds,
        "uuids": {
            f"alice@{outbound}": "11111111-1111-1111-1111-111111111111"
            for outbound in outbounds
        },
    }


def build_share_service_fixture():
    """Return full share-link scenarios rendered by the Python service."""
    alice_key = base64.urlsafe_b64encode(
        bytes.fromhex(
            "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"
        )
    ).decode().rstrip("=")
    profiles = {
        "XHTTP_IN": [
            {
                "id": "cdn",
                "label": "CDN",
                "overrides": {"address": "cdn.example.com", "port": 443},
            }
        ]
    }
    disabled = share_user(["REALITY_IN"], ["JAPAN"])
    disabled["status"] = "disabled"
    scenarios = [
        {
            "name": "raw_reality",
            "user": share_user(["REALITY_IN"], ["JAPAN"]),
            "configured_address": "example.com",
        },
        {
            "name": "reality_key_override",
            "user": share_user(["REALITY_IN"], ["JAPAN"]),
            "configured_address": "example.com",
            "reality_keys": {"REALITY_IN": alice_key},
        },
        {
            "name": "xhttp_address_fallback",
            "user": share_user(["XHTTP_IN"], ["JAPAN"]),
            "configured_address": "",
        },
        {
            "name": "wildcard_listens_only",
            "user": share_user(["REALITY_IN", "XHTTP_IN", "WS_IN"], ["JAPAN"]),
            "configured_address": "",
        },
        {
            "name": "profiles_and_labels",
            "user": share_user(["XHTTP_IN"], ["JAPAN"]),
            "configured_address": "example.com",
            "profiles": profiles,
            "node_label": "Tokyo 01",
            "labels": {"XHTTP_IN": "XHTTP", "JAPAN": "Japan"},
        },
        {
            "name": "profile_supplies_address",
            "user": share_user(["REALITY_IN"], ["JAPAN"]),
            "configured_address": "",
            "profiles": {
                "REALITY_IN": [
                    {
                        "id": "cdn",
                        "label": "CDN",
                        "overrides": {"address": "cdn.example.com", "port": 443},
                    }
                ]
            },
        },
        {
            "name": "two_exits_one_profile",
            "user": share_user(["XHTTP_IN"], ["HK", "JAPAN"]),
            "configured_address": "example.com",
            "profiles": profiles,
        },
        {
            "name": "disabled_user",
            "user": disabled,
            "configured_address": "example.com",
        },
        {
            "name": "non_vless_and_unknown",
            "user": share_user(["REALITY_IN", "HTTP_ONLY"], ["JAPAN", "NOWHERE"]),
            "configured_address": "example.com",
        },
    ]
    config = share_config()
    rendered = []
    for scenario in scenarios:
        links, warnings = share_service.links_for_user(
            scenario["user"],
            config,
            scenario["configured_address"],
            reality_keys=scenario.get("reality_keys"),
            profiles=scenario.get("profiles"),
            node_label=scenario.get("node_label"),
            labels=scenario.get("labels"),
        )
        rendered.append(
            {
                "name": scenario["name"],
                "user": scenario["user"],
                "configured_address": scenario["configured_address"],
                "reality_keys": scenario.get("reality_keys"),
                "profiles": scenario.get("profiles"),
                "node_label": scenario.get("node_label"),
                "labels": scenario.get("labels"),
                "links": links,
                "warnings": warnings,
            }
        )
    return {"config": config, "scenarios": rendered}


def build_fixtures():
    """Return every fixture file as {filename: payload}."""
    return {
        "python_json.json": build_python_json_fixture(),
        "python_uri.json": build_python_uri_fixture(),
        "x25519.json": build_x25519_fixture(),
        "node_token.json": build_node_token_fixture(),
        "share_service.json": build_share_service_fixture(),
    }


def serialize(payload):
    """Return the exact fixture file text: indented, ASCII, LF, final newline."""
    return json.dumps(payload, indent=2, ensure_ascii=True) + "\n"


def main():
    """Write the fixtures, or check that the committed files are current."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero when a fixture file is missing or stale",
    )
    args = parser.parse_args()

    fixtures = build_fixtures()
    stale = []
    for name, payload in fixtures.items():
        path = FIXTURES_DIR / name
        text = serialize(payload)
        if args.check:
            current = path.read_text(encoding="utf-8") if path.exists() else None
            if current != text:
                stale.append(name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        print(f"wrote {path.relative_to(REPO_ROOT)}")

    if args.check:
        if stale:
            print("stale fixtures: " + ", ".join(stale))
            sys.exit(1)
        print("fixtures are up to date")


if __name__ == "__main__":
    main()
