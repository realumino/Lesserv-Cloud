"""Qualify local tags for one node without changing the pure render core.

Why this exists: stored configs, access rows, keys, and profiles use local
tags (`reality`, `niigata`) so one authored config can move between nodes.
Rendering and share links need node-scoped names (`reality-tokyo01`,
`tokyo01-niigata`) so emails, routing rules, and statistics stay globally
unambiguous. This module performs only that renaming.

Why separate from `config_service`: the copied render core receives inputs
that already look like a single-node panel. Qualification happens before it
runs, so `build_config` and `apply_reality_keys` never learn about nodes.

Why idempotency is structural: node ids cannot contain hyphens, so an
inbound ending in `-{node_id}` and an outbound beginning with `{node_id}-`
can only be an already-qualified name. Re-running qualification must leave
such names unchanged.
"""

import copy

BLOCK_TAG = "BLOCK"


def is_qualified_inbound_tag(tag, node_id) -> bool:
    """Return True when an inbound tag already carries this node's suffix."""
    return isinstance(tag, str) and bool(tag) and tag.endswith(f"-{node_id}")


def is_qualified_outbound_tag(tag, node_id) -> bool:
    """Return True when an outbound tag already carries this node's prefix."""
    return isinstance(tag, str) and bool(tag) and tag.startswith(f"{node_id}-")


def qualified_inbound_tag(tag, node_id) -> str:
    """Return one inbound tag with this node's suffix, unless already qualified.

    Why defensive about non-strings: malformed configs are handled as render
    warnings elsewhere; the qualifier must preserve and never invent tags.
    """
    if is_qualified_inbound_tag(tag, node_id):
        return tag
    if not isinstance(tag, str) or not tag:
        return tag
    return f"{tag}-{node_id}"


def qualified_outbound_tag(tag, node_id) -> str:
    """Return one outbound tag with this node's prefix, unless already qualified.

    Why `BLOCK` is exempt: it is the shared default route, not a routable
    exit. Prefixing it would break the panel-owned fallback and generated
    rule suppression.
    """
    if tag == BLOCK_TAG:
        return tag
    if is_qualified_outbound_tag(tag, node_id):
        return tag
    if not isinstance(tag, str) or not tag:
        return tag
    return f"{node_id}-{tag}"


def _known_tags(entries) -> set:
    """Return the non-empty string tags in one inbound or outbound list."""
    tags = set()
    for entry in entries if isinstance(entries, list) else []:
        if isinstance(entry, dict):
            tag = entry.get("tag")
            if isinstance(tag, str) and tag:
                tags.add(tag)
    return tags


def _qualify_entries(entries, qualifier) -> None:
    """Qualify tags in place in an already-copied inbound or outbound list."""
    if not isinstance(entries, list):
        return
    for entry in entries:
        if isinstance(entry, dict):
            entry["tag"] = qualifier(entry.get("tag"))


def _split_reference(value) -> tuple:
    """Split a routing user entry into leading text, tag, and trailing marker.

    Why only trailing tags are supported: generated emails have the form
    `username@tag`, optionally inside `regexp:...` and ending with `$`. A
    non-terminal tag is not an allocation reference and must stay untouched.
    """
    text = value
    suffix = ""
    if text.startswith("regexp:"):
        text = text[len("regexp:"):]
    if text.endswith("$"):
        text = text[:-1]
        suffix = "$"
    leading, separator, tag = text.rpartition("@")
    if not separator or not leading or not tag:
        return None
    prefix = f"regexp:{leading}@" if value.startswith("regexp:") else f"{leading}@"
    return prefix, tag, suffix


def _rewrite_known_reference(value, known_tags, node_id) -> str:
    """Rewrite one routing user reference when its trailing tag is known."""
    if not isinstance(value, str):
        return value
    parts = _split_reference(value)
    if parts is None:
        return value
    prefix, tag, suffix = parts
    if tag not in known_tags:
        return value
    return f"{prefix}{qualified_outbound_tag(tag, node_id)}{suffix}"


def _rewrite_reference_list(values, known_tags, node_id) -> object:
    """Rewrite references in a string or list while preserving its shape."""
    if isinstance(values, str):
        return _rewrite_known_reference(values, known_tags, node_id)
    if isinstance(values, list):
        return [
            _rewrite_known_reference(value, known_tags, node_id)
            for value in values
        ]
    return values


def _qualify_tagged_reference(value, known_tags, qualifier):
    """Qualify an inbound or outbound reference only when the tag is known."""
    if isinstance(value, str) and value in known_tags:
        return qualifier(value)
    return value


def _qualify_reference_list(values, known_tags, qualifier):
    """Qualify tag references in a string or list while preserving its shape."""
    if isinstance(values, str):
        return _qualify_tagged_reference(values, known_tags, qualifier)
    if isinstance(values, list):
        return [
            _qualify_tagged_reference(value, known_tags, qualifier)
            for value in values
        ]
    return values


def _qualify_routing_rule(rule, inbound_tags, outbound_tags, node_id) -> None:
    """Rewrite tag references in one already-copied routing rule in place."""
    if not isinstance(rule, dict):
        return
    if "outboundTag" in rule:
        rule["outboundTag"] = _qualify_tagged_reference(
            rule["outboundTag"], outbound_tags,
            lambda tag: qualified_outbound_tag(tag, node_id),
        )
    if "inboundTag" in rule:
        rule["inboundTag"] = _qualify_reference_list(
            rule["inboundTag"], inbound_tags,
            lambda tag: qualified_inbound_tag(tag, node_id),
        )
    if "user" in rule:
        rule["user"] = _rewrite_reference_list(
            rule["user"], outbound_tags, node_id
        )


def _qualify_routing(config, inbound_tags, outbound_tags, node_id) -> None:
    """Rewrite tag references in an already-copied routing section in place."""
    routing = config.get("routing")
    if not isinstance(routing, dict):
        return
    rules = routing.get("rules")
    if not isinstance(rules, list):
        return
    for rule in rules:
        _qualify_routing_rule(rule, inbound_tags, outbound_tags, node_id)


def qualify_config(config, node_id) -> dict:
    """Return a qualified copy of one authored config.

    Why a copy: the stored config must remain identity-free. The caller may
    reuse the same authored object for another node, so mutation would leak
    one node's identity into another render.
    """
    qualified = copy.deepcopy(config)
    if not isinstance(qualified, dict):
        return qualified
    inbound_tags = _known_tags(qualified.get("inbounds"))
    outbound_tags = _known_tags(qualified.get("outbounds"))
    _qualify_entries(
        qualified.get("inbounds"),
        lambda tag: qualified_inbound_tag(tag, node_id),
    )
    _qualify_entries(
        qualified.get("outbounds"),
        lambda tag: qualified_outbound_tag(tag, node_id),
    )
    _qualify_routing(qualified, inbound_tags, outbound_tags, node_id)
    return qualified


def _qualify_string_list(values, qualifier) -> object:
    """Qualify the strings in a list while leaving other values unchanged."""
    if not isinstance(values, list):
        return values
    return [qualifier(value) for value in values]


def _qualify_email_key(email, node_id):
    """Qualify the outbound part of a `username@tag` uuid-map key."""
    if not isinstance(email, str):
        return email
    username, separator, tag = email.partition("@")
    if not separator or not username or not tag:
        return email
    return f"{username}@{qualified_outbound_tag(tag, node_id)}"


def _qualify_user(user, node_id) -> dict:
    """Return one projected user with node-qualified lists and uuid keys."""
    qualified = dict(user)
    qualified["allowed_inbounds"] = _qualify_string_list(
        user.get("allowed_inbounds"),
        lambda tag: qualified_inbound_tag(tag, node_id),
    )
    qualified["allowed_outbounds"] = _qualify_string_list(
        user.get("allowed_outbounds"),
        lambda tag: qualified_outbound_tag(tag, node_id),
    )
    uuids = user.get("uuids")
    if isinstance(uuids, dict):
        qualified["uuids"] = {
            _qualify_email_key(email, node_id): value
            for email, value in uuids.items()
        }
    return qualified


def qualify_users(users, node_id) -> list:
    """Return projected users with node-qualified access and uuid keys.

    Why the stored rows are not enough: the render projection builds uuid
    keys as `username@local-tag`; the allocator then needs those same keys
    with qualified tags. This is the only function that touches those keys.
    """
    return [
        _qualify_user(user, node_id) if isinstance(user, dict) else user
        for user in users or []
    ]


def qualify_keys(keys, node_id) -> dict:
    """Return stored REALITY keys indexed by qualified inbound tag.

    Why reindex here: storage follows local inbound tags, while the runtime
    produced from a qualified config looks keys up by qualified tag. The
    stored map itself is never changed.
    """
    return {
        qualified_inbound_tag(tag, node_id): value
        for tag, value in (keys or {}).items()
    }


def qualify_profiles(profiles, node_id) -> dict:
    """Group link profiles by qualified inbound tag for link generation.

    Why the grouping shape: links are generated from the qualified config,
    while profiles are stored against local inbound tags. Grouping once lets
    the link loop find every variant for the current inbound directly.
    """
    grouped = {}
    for profile in profiles or []:
        if not isinstance(profile, dict):
            continue
        inbound = profile.get("inbound_tag")
        if not isinstance(inbound, str) or not inbound:
            continue
        entry = {
            "id": profile.get("id"),
            "label": profile.get("label"),
            "overrides": dict(profile.get("overrides") or {}),
        }
        grouped.setdefault(qualified_inbound_tag(inbound, node_id), []).append(entry)
    for entries in grouped.values():
        entries.sort(key=lambda entry: entry.get("id") or "")
    return dict(sorted(grouped.items()))


def _tag_errors(entries, kind, node_id, is_qualified) -> list:
    """Report blank or already-qualified tags in one config section."""
    errors = []
    if not isinstance(entries, list):
        return errors
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        tag = entry.get("tag")
        if not isinstance(tag, str) or not tag:
            errors.append(f"{kind} {position} has no tag")
        elif is_qualified(tag, node_id):
            errors.append(
                f"{kind} tag '{tag}' is already qualified for node '{node_id}'"
            )
    return errors


def local_tag_errors(config, node_id) -> list:
    """Return paste-time errors for local inbound and outbound tags.

    Why only this validation: the config remains otherwise opaque. This
    check prevents an already-qualified tag from being qualified again at
    render time, which would otherwise produce names such as
    `reality-tokyo01-tokyo01`.
    """
    if not isinstance(config, dict):
        return []
    errors = _tag_errors(
        config.get("inbounds"), "inbound", node_id, is_qualified_inbound_tag
    )
    errors.extend(_tag_errors(
        config.get("outbounds"), "outbound", node_id, is_qualified_outbound_tag
    ))
    return errors
