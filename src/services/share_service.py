"""Build VLESS share links from a user and the Xray config.

Why this is a separate service: turning users + inbounds into `vless://`
URIs is a pure transformation. It never touches the filesystem or
subprocess, so it can be unit-tested with plain dicts. Optional profiles
add extra client-side variants without changing the direct URI behavior.
"""

from urllib.parse import quote, urlencode

from core.x25519 import derive_public_key
from services import labels as display_labels


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


def has_usable_address(config, configured, profile_addresses=()):
    """Return True when at least one inbound has a resolvable address.

    Why this exists: the router needs to distinguish "no address" (409)
    from "links could be built for some inbounds". A profile may supply
    the client-facing address even when the direct view cannot resolve one.
    """
    if configured:
        return True
    for inbound in config.get("inbounds", []):
        if resolve_address(None, inbound) is not None:
            return True
    return any(bool(address) for address in profile_addresses or [])


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


def _build_uri(email, uuid, address, port, params, inbound_tag, remark=None):
    """Assemble a vless:// URI from its parts.

    Why params are ordered explicitly: deterministic URIs are easier to
    test and compare. `quote` is used instead of the default
    `quote_plus` so spaces become %20, not `+`. A supplied readable remark
    replaces the archived technical remark; otherwise behavior is unchanged.
    """
    host = _host_in_uri(address)
    query = urlencode(params, quote_via=quote, safe="")
    remark = remark if remark is not None else f"{email} ({inbound_tag})"
    return f"vless://{uuid}@{host}:{port}?{query}#{quote(remark, safe='')}"


def _index_config(config):
    """Index a config's outbound set and inbound map for link generation."""
    outbound_tags = {
        outbound["tag"] for outbound in config.get("outbounds", [])
    }
    inbounds = {
        inbound["tag"]: inbound for inbound in config.get("inbounds", [])
    }
    return outbound_tags, inbounds


def _exit_requests(user, outbound_tags):
    """Return per-exit link requests and warnings for unusable exits."""
    requests = []
    warnings = []
    for outbound_tag in sorted(user.get("allowed_outbounds", [])):
        if outbound_tag not in outbound_tags:
            warnings.append(f"unknown outbound '{outbound_tag}'")
            continue
        email = f"{user['username']}@{outbound_tag}"
        uuid = user["uuids"].get(email)
        if not uuid:
            warnings.append(f"missing uuid for {email}")
            continue
        requests.append({
            "outbound_tag": outbound_tag,
            "email": email,
            "uuid": uuid,
        })
    return requests, warnings


def _profile_variants(inbound_tag, profiles):
    """Return the direct variant followed by attached profile variants."""
    variants = [{"profile_id": None, "label": None, "overrides": {}}]
    for profile in (profiles or {}).get(inbound_tag, []):
        variants.append({
            "profile_id": profile.get("id"),
            "label": profile.get("label"),
            "overrides": dict(profile.get("overrides") or {}),
        })
    return variants


def _variant_address_port(variant, address, port):
    """Return one variant's URI address and port, with overrides applied."""
    overrides = variant.get("overrides") or {}
    variant_address = overrides.get("address") or address
    variant_port = overrides.get("port")
    if variant_port is None:
        variant_port = port
    return variant_address, variant_port


def _variant_label(variant, inbound_tag, outbound_tag, node_label, labels):
    """Return one variant's readable label, or None for pure callers."""
    if node_label is None:
        return None
    subject = variant.get("label") or labels.get(inbound_tag, inbound_tag)
    return display_labels.link_label(
        node_label, subject, labels.get(outbound_tag, outbound_tag)
    )


def _variant_link(email, uuid, inbound_tag, outbound_tag, variant,
                  address, port, params, node_label, labels):
    """Build one link variant or report its missing address.

    Why profile overrides win: a profile is an intentional client-side
    replacement for connection details. Address and port have dedicated
    handling because they are URI components rather than query parameters.
    """
    overrides = variant.get("overrides") or {}
    variant_address, variant_port = _variant_address_port(variant, address, port)
    if not variant_address:
        return None, [f"no address for inbound '{inbound_tag}'"]
    variant_params = dict(params)
    for key, value in overrides.items():
        if key not in ("address", "port"):
            variant_params[key] = value
    label = _variant_label(variant, inbound_tag, outbound_tag, node_label, labels)
    uri = _build_uri(
        email, uuid, variant_address, variant_port, variant_params,
        inbound_tag, remark=label,
    )
    link = {
        "inbound": inbound_tag,
        "outbound": outbound_tag,
        "email": email,
        "profile": variant.get("profile_id"),
        "label": label,
        "uri": uri,
    }
    return link, []


def _links_for_inbound(email, uuid, inbound_tag, inbound, outbound_tag, link_input):
    """Build direct and profile links for one allowed inbound."""
    links = []
    warnings = []
    port = inbound.get("port")
    if not port:
        return links, [f"inbound '{inbound_tag}' missing port"]
    address = resolve_address(link_input["configured_address"], inbound)
    transport, transport_warnings = _transport_params(inbound)
    security, security_warnings = _security_params(
        inbound, link_input["reality_keys"]
    )
    warnings.extend(transport_warnings)
    warnings.extend(security_warnings)
    params = {"encryption": "none"}
    params.update(transport)
    params.update(security)
    params.update(_flow_params(inbound))
    for variant in _profile_variants(inbound_tag, link_input["profiles"]):
        link, variant_warnings = _variant_link(
            email, uuid, inbound_tag, outbound_tag, variant, address, port,
            params, link_input["node_label"], link_input["labels"],
        )
        warnings.extend(variant_warnings)
        if link is not None:
            links.append(link)
    return links, warnings


def _links_for_exit(request, allowed_inbounds, config_inbounds, link_input):
    """Build every link for one exit across the user's allowed inbounds."""
    links = []
    warnings = []
    for inbound_tag in sorted(allowed_inbounds):
        inbound = config_inbounds.get(inbound_tag)
        if not inbound:
            warnings.append(f"unknown inbound '{inbound_tag}'")
            continue
        if inbound.get("protocol") != "vless":
            warnings.append(f"skipping non-vless inbound '{inbound_tag}'")
            continue
        inbound_links, inbound_warnings = _links_for_inbound(
            request["email"], request["uuid"], inbound_tag, inbound,
            request["outbound_tag"], link_input,
        )
        links.extend(inbound_links)
        warnings.extend(inbound_warnings)
    return links, warnings


def _links_for_requests(requests, allowed_inbounds, config_inbounds, link_input):
    """Build links and warnings for every usable exit request."""
    links = []
    warnings = []
    for request in requests:
        exit_links, exit_warnings = _links_for_exit(
            request, allowed_inbounds, config_inbounds, link_input
        )
        links.extend(exit_links)
        warnings.extend(exit_warnings)
    return links, warnings


def _finalize_links(username, status, links, warnings):
    """Add status warnings and return links in deterministic order."""
    if status != "active":
        warnings.append(f"user {username} is disabled")
    links.sort(key=lambda link: (
        link["inbound"], link["outbound"], link["profile"] or ""
    ))
    return links, warnings


def links_for_user(user, config, configured_address, reality_keys=None,
                   profiles=None, node_label=None, labels=None):
    """Return all share links for a user plus warnings.

    Why one link per (inbound, outbound) pair: the UUID differs per
    outbound email, so a single user has a distinct URI for each exit
    node they are allowed to use. Each profile attached to an inbound adds
    one more URI per exit, using the same UUID but its own client-facing
    connection details.

    Why reality_keys is optional: the router always passes the DB map;
    the default keeps this function usable without a database (tests,
    ad-hoc scripts) with links derived from the config's own keys.
    """
    username = user["username"]
    outbound_tags, config_inbounds = _index_config(config)
    requests, warnings = _exit_requests(user, outbound_tags)
    link_input = {
        "configured_address": configured_address,
        "reality_keys": reality_keys,
        "profiles": profiles or {},
        "node_label": node_label,
        "labels": labels or {},
    }
    links, request_warnings = _links_for_requests(
        requests, user.get("allowed_inbounds", []), config_inbounds, link_input
    )
    warnings.extend(request_warnings)
    return _finalize_links(user["username"], user.get("status"), links, warnings)
