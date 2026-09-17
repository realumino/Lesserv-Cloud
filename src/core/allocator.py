"""Allocate VLESS clients and routing rules from user permissions.

Pure processor: no I/O, no UUID generation, no config mutation. Callers supply
user permissions, the list of inbounds, and a pre-generated UUID map; this
module returns data structures the caller can inject wherever it wants.

Note: the protocol check uses the inline literal "vless" (not a named constant)
because the check appears exactly once. If Xray ever introduces another
protocol that should be treated like VLESS, update this single string.
"""


def allocate(user_permissions, inbounds, outbound_tags, uuids):
    """Allocate clients per inbound and routing rules per outbound.

    Args:
        user_permissions: {username: {"allowed_inbounds": [...],
                                       "allowed_outbounds": [...]}}
        inbounds: [{"tag": str, "protocol": str}, ...]
                   Caller may filter to VLESS before passing; non-VLESS
                   tags are skipped here with a warning.
        outbound_tags: [str, ...]  outbound tag strings from the config
        uuids: {"username@outboundtag": "uuid-v4-string", ...}
               Caller-owned UUID store. Read-only here.

    Returns:
        clients_by_inbound: {inbound_tag: [{"id": uuid, "email": email}, ...]}
        routing_rules: [{"user": ["regexp:.*@<tag>$"], "outboundTag": tag}, ...]
        warnings: list of human-readable strings about skipped entries
    """
    protocols = {entry["tag"]: entry.get("protocol") for entry in inbounds}
    clients_by_inbound = {}
    warnings = []
    seen_warnings = set()

    for username, perms in user_permissions.items():
        for outbound_tag in perms.get("allowed_outbounds", []):
            email = "%s@%s" % (username, outbound_tag)
            client_id = uuids.get(email)
            if not client_id:
                message = "missing uuid for %r" % email
                if message not in seen_warnings:
                    seen_warnings.add(message)
                    warnings.append(message)
                continue
            for inbound_tag in perms.get("allowed_inbounds", []):
                if protocols.get(inbound_tag) != "vless":
                    message = "skipping non-vless inbound '%s'" % inbound_tag
                    if message not in seen_warnings:
                        seen_warnings.add(message)
                        warnings.append(message)
                    continue
                clients_by_inbound.setdefault(inbound_tag, []).append(
                    {"id": client_id, "email": email}
                )

    routing_rules = [
        {"user": ["regexp:.*@%s$" % tag], "outboundTag": tag}
        for tag in outbound_tags
    ]

    return clients_by_inbound, routing_rules, warnings
