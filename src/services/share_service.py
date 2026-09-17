"""Build VLESS share links from a user and the Xray config.

Why this is a separate service: turning users + inbounds into `vless://`
URIs is a pure transformation. It never touches the filesystem or
subprocess, so it can be unit-tested with plain dicts.
"""

from urllib.parse import quote, urlencode

from core.x25519 import derive_public_key


WILDCARD_LISTENS = frozenset({"", "0.0.0.0", "::"})


def resolve_address(configured, inbound):
    """Return the server address for an inbound.

    Why the configured address wins: the operator's public domain/IP is
    not necessarily the same address Xray binds to (often `0.0.0.0`).
    """
    if configured:
        return configured
    listen = inbound.get("listen", "")
    if listen in WILDCARD_LISTENS:
        return None
    return listen


def has_usable_address(config, configured):
    """Return True when at least one inbound has a resolvable address.

    Why this exists: the router needs to distinguish "no address" (409)
    from "links could be built for some inbounds".
    """
    if configured:
        return True
    for inbound in config.get("inbounds", []):
        if resolve_address(None, inbound) is not None:
            return True
    return False


def _host_in_uri(address):
    """Bracket IPv6 addresses; leave IPv4/domain as-is."""
    if ":" in address:
        return f"[{address}]"
    return address


def _first(values):
    """Return the first non-empty item of a list, or None."""
    if not values:
        return None
    value = values[0]
    return value if value else None


def _transport_params(inbound):
    """Build transport query params and any warnings for an inbound.

    Why the network names are mapped: the share-link standard uses
    `type=tcp` for the RAW transport, even though Xray 25+ calls it
    `raw` in the config.
    """
    stream = inbound.get("streamSettings") or {}
    network = stream.get("network", "tcp")
    params = {}
    warnings = []

    if network == "raw":
        params["type"] = "tcp"
    else:
        params["type"] = network

    if network in ("tcp", "raw"):
        return params, warnings

    if network == "ws":
        ws = stream.get("wsSettings") or {}
        if ws.get("path"):
            params["path"] = ws["path"]
        if ws.get("host"):
            params["host"] = ws["host"]
    elif network == "xhttp":
        xhttp = stream.get("xhttpSettings") or {}
        if xhttp.get("path"):
            params["path"] = xhttp["path"]
        if xhttp.get("host"):
            params["host"] = xhttp["host"]
        if xhttp.get("mode"):
            params["mode"] = xhttp["mode"]
    elif network == "grpc":
        grpc = stream.get("grpcSettings") or {}
        if grpc.get("serviceName"):
            params["serviceName"] = grpc["serviceName"]
        if grpc.get("multiMode"):
            params["mode"] = "multi"
    elif network == "httpupgrade":
        hu = stream.get("httpupgradeSettings") or {}
        if hu.get("path"):
            params["path"] = hu["path"]
        if hu.get("host"):
            params["host"] = hu["host"]
    else:
        warnings.append(f"unsupported network '{network}' for inbound '{inbound.get('tag')}'")

    return params, warnings


def _security_params(inbound, reality_keys=None):
    """Build security query params and any warnings for an inbound.

    Why the private key comes from `reality_keys` when available: the
    panel owns realitySettings.privateKey (stored in SQLite, injected at
    sync), so the config file's copy may be stale or a placeholder.
    Deriving `pbk` from the panel's key is what makes links match what
    Xray actually serves. The config value remains the fallback so pure
    callers without a database still work.
    """
    stream = inbound.get("streamSettings") or {}
    security = stream.get("security", "none")
    params = {}
    warnings = []

    if security == "none":
        return params, warnings

    params["security"] = security

    if security == "reality":
        reality = stream.get("realitySettings") or {}
        sni = _first(reality.get("serverNames") or [])
        if sni:
            params["sni"] = sni

        settings = reality.get("settings") or {}
        fp = settings.get("fingerprint") or reality.get("fingerprint")
        params["fp"] = fp or "chrome"

        private_key = (
            (reality_keys or {}).get(inbound.get("tag"))
            or reality.get("privateKey")
        )
        if private_key:
            pbk = derive_public_key(private_key)
            if pbk:
                params["pbk"] = pbk
            else:
                warnings.append(
                    f"invalid privateKey for inbound '{inbound.get('tag')}'"
                )
        else:
            warnings.append(
                f"missing privateKey for inbound '{inbound.get('tag')}'"
            )

        short_id = _first(reality.get("shortIds") or [])
        if short_id:
            params["sid"] = short_id

        if reality.get("spiderX"):
            params["spx"] = reality["spiderX"]

    elif security == "tls":
        tls = stream.get("tlsSettings") or {}
        sni = tls.get("serverName") or _first(tls.get("serverNames") or [])
        if sni:
            params["sni"] = sni
        if tls.get("alpn"):
            params["alpn"] = ",".join(tls["alpn"])
        fp = tls.get("fingerprint") or (tls.get("settings") or {}).get("fingerprint")
        if fp:
            params["fp"] = fp

    return params, warnings


def _flow_params(inbound):
    """Return the VLESS `flow` query param when the inbound sets one.

    Why flow comes from the inbound: Xray lets the operator declare flow
    once per inbound (`settings.flow`) instead of per client, so there is
    nothing user-specific to store. The panel echoes whatever the
    operator wrote without judging whether it fits the transport.
    """
    flow = (inbound.get("settings") or {}).get("flow")
    return {"flow": flow} if flow else {}


def _build_uri(email, uuid, address, port, params, inbound_tag):
    """Assemble a vless:// URI from its parts.

    Why params are ordered explicitly: deterministic URIs are easier to
    test and compare. `quote` is used instead of the default
    `quote_plus` so spaces become %20, not `+`.
    """
    host = _host_in_uri(address)
    query = urlencode(params, quote_via=quote, safe="")
    remark = f"{email} ({inbound_tag})"
    return f"vless://{uuid}@{host}:{port}?{query}#{quote(remark, safe='')}"


def links_for_user(user, config, configured_address, reality_keys=None):
    """Return all share links for a user plus warnings.

    Why one link per (inbound, outbound) pair: the UUID differs per
    outbound email, so a single user has a distinct URI for each exit
    node they are allowed to use.

    Why reality_keys is optional: the router always passes the DB map;
    the default keeps this function usable without a database (tests,
    ad-hoc scripts) with links derived from the config's own keys.
    """
    username = user["username"]
    warnings = []
    links = []

    config_outbounds = {
        outbound["tag"] for outbound in config.get("outbounds", [])
    }
    config_inbounds = {
        inbound["tag"]: inbound for inbound in config.get("inbounds", [])
    }

    for outbound_tag in sorted(user.get("allowed_outbounds", [])):
        if outbound_tag not in config_outbounds:
            warnings.append(f"unknown outbound '{outbound_tag}'")
            continue

        email = f"{username}@{outbound_tag}"
        uuid = user["uuids"].get(email)
        if not uuid:
            warnings.append(f"missing uuid for {email}")
            continue

        for inbound_tag in sorted(user.get("allowed_inbounds", [])):
            inbound = config_inbounds.get(inbound_tag)
            if not inbound:
                warnings.append(f"unknown inbound '{inbound_tag}'")
                continue
            if inbound.get("protocol") != "vless":
                warnings.append(f"skipping non-vless inbound '{inbound_tag}'")
                continue

            port = inbound.get("port")
            if not port:
                warnings.append(f"inbound '{inbound_tag}' missing port")
                continue

            address = resolve_address(configured_address, inbound)
            if not address:
                warnings.append(f"no address for inbound '{inbound_tag}'")
                continue

            transport, t_warnings = _transport_params(inbound)
            security, s_warnings = _security_params(inbound, reality_keys)
            warnings.extend(t_warnings)
            warnings.extend(s_warnings)

            params = {"encryption": "none"}
            params.update(transport)
            params.update(security)
            params.update(_flow_params(inbound))

            uri = _build_uri(email, uuid, address, port, params, inbound_tag)
            links.append({
                "inbound": inbound_tag,
                "outbound": outbound_tag,
                "email": email,
                "uri": uri,
            })

    if user.get("status") != "active":
        warnings.append(f"user {username} is disabled")

    links.sort(key=lambda link: (link["inbound"], link["outbound"]))
    return links, warnings
