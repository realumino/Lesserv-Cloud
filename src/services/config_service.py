"""Build the filled runtime Xray config from the user config and users.

Why this exists: turning DB users into `settings.clients` and
`routing.rules` is a pure transformation — no bindings, no I/O — so it
runs identically under Pyodide and is unit-tested with plain dicts.
"""

import copy

from core import allocator


def user_permissions(users):
    """Return {username: {allowed_inbounds, allowed_outbounds}} for active users.

    Why disabled users are dropped here: a disabled user must disappear
    from the Xray config on the next sync, so the allocator never sees
    them.
    """
    return {
        user["username"]: {
            "allowed_inbounds": user["allowed_inbounds"],
            "allowed_outbounds": user["allowed_outbounds"],
        }
        for user in users
        if user["status"] == "active"
    }


def uuids_map(users):
    """Merge every active user's uuid map into one flat {email: uuid} dict.

    Why one flat dict: the allocator is keyed by email
    (username@outboundtag) and knows nothing about users.
    """
    merged = {}
    for user in users:
        if user["status"] == "active":
            merged.update(user["uuids"])
    return merged


def inbound_summaries(config):
    """Extract {tag, protocol, network, security} from every inbound.

    Why this exists: the allocator only needs tag + protocol; the API
    endpoint also exposes network and security so the frontend can show
    richer checkboxes. Extra fields in the dict don't hurt the allocator.
    """
    result = []
    for inbound in config["inbounds"]:
        stream = inbound.get("streamSettings") or {}
        result.append({
            "tag": inbound["tag"],
            "protocol": inbound["protocol"],
            "network": stream.get("network", ""),
            "security": stream.get("security", ""),
        })
    return result


def outbound_tags(config):
    """Return the tag strings of every regular outbound (BLOCK excluded).

    Why BLOCK is excluded: it is the default route (guaranteed first by
    ensure_block_first), not a real exit node; the allocator must not
    generate a regexp:.*@BLOCK$ rule for it.
    """
    return [o["tag"] for o in config["outbounds"] if o["tag"] != "BLOCK"]


def outbound_summaries(config):
    """Extract {tag, protocol} from every outbound in the config.

    Why this exists: the allocator needs just the tag strings, but the
    API endpoint also exposes the protocol so the frontend can show
    richer checkboxes.
    """
    return [
        {"tag": outbound["tag"], "protocol": outbound["protocol"]}
        for outbound in config["outbounds"]
    ]


def reality_inbound_tags(config):
    """Return the tags of every inbound that has streamSettings.realitySettings.

    Why presence of realitySettings decides (not security == "reality"): a
    missing or misspelled security value must not silently skip the
    private key — the panel owns that field whenever the settings block
    exists. Protocol-agnostic on purpose: REALITY belongs to VLESS in
    practice, but keying off the settings block keeps this simple and
    covers any future reality-capable inbound.
    """
    tags = []
    for inbound in config["inbounds"]:
        stream = inbound.get("streamSettings") or {}
        if isinstance(stream.get("realitySettings"), dict):
            tags.append(inbound["tag"])
    return tags


def apply_reality_keys(runtime, keys):
    """Overwrite realitySettings.privateKey of every REALITY inbound; return warnings.

    Why a separate pure step instead of part of build_config: build_config
    keeps its original signature (and its tests); the private-key fill is
    a distinct panel-owned concern that the caller composes in. `runtime`
    must be the deep copy made by build_config — mutating the caller's
    config dict would break the opaque-preservation promise.

    Why a missing key only warns: `ensure_keys` guarantees one key per
    reality inbound, so a gap here is a bug, not an operator error — but
    keeping the config's own value beats crashing or writing an empty key.
    """
    warnings = []
    for inbound in runtime["inbounds"]:
        stream = inbound.get("streamSettings") or {}
        reality = stream.get("realitySettings")
        if not isinstance(reality, dict):
            continue
        if inbound["tag"] not in keys:
            warnings.append(
                f"no generated REALITY key for inbound '{inbound['tag']}';"
                " keeping the config's own value"
            )
            continue
        reality["privateKey"] = keys[inbound["tag"]]
    return warnings


def clients_and_rules(users, config):
    """Run the allocator; return (clients_by_inbound, routing_rules, warnings).

    Why no catch-all rule is appended: an Xray routing rule needs at least
    one matcher (user, domain, ip, ...), so a rule carrying only an
    outboundTag is an error, not a catch-all. Unmatched traffic is already
    handled by Xray itself, which falls back to the FIRST outbound — the
    panel guarantees that outbound is BLOCK (see ensure_block_first).
    """
    return allocator.allocate(
        user_permissions(users),
        inbound_summaries(config),
        outbound_tags(config),
        uuids_map(users),
    )


def ensure_block_first(outbounds):
    """Return the outbound list with a blackhole BLOCK guaranteed at index 0.

    Why first: when no routing rule matches, Xray uses the FIRST outbound
    as the default. Placing BLOCK there makes it the catch-all for traffic
    whose email matched no per-outbound rule — replacing the old
    matcher-less catch-all rule, which Xray rejects as an error.

    Why the existing BLOCK dict is kept verbatim: the operator may have
    customized it (extra settings, response); only its position changes.
    """
    block = next((o for o in outbounds if o.get("tag") == "BLOCK"), None)
    if block is None:
        block = {"tag": "BLOCK", "protocol": "blackhole"}
    rest = [o for o in outbounds if o.get("tag") != "BLOCK"]
    return [block] + rest


def build_config(config, users):
    """Return a deep copy of the config with clients and routing filled in.

    Why a deep copy: the caller's config dict must stay untouched — it is
    re-read from disk on every sync, and mutating it would leak filled
    state into the opaque parts we promise to preserve.

    Why routing is optional: novice operators may omit the routing section
    entirely; the panel creates it automatically. When the user does supply
    their own routing.rules, the generated rules are appended after them so
    user-authored rules stay at the front.

    Why BLOCK is forced to the first outbound: an Xray rule needs at least
    one matcher, so the old matcher-less catch-all rule was an error. Xray's
    own fallback — "no rule matched -> first outbound" — replaces it, and
    ensure_block_first guarantees that fallback is BLOCK (injecting a
    blackhole BLOCK outbound when none exists).
    """
    runtime = copy.deepcopy(config)
    runtime["outbounds"] = ensure_block_first(runtime.get("outbounds", []))
    clients, rules, warnings = clients_and_rules(users, runtime)
    for inbound in runtime["inbounds"]:
        if inbound["protocol"] != "vless":
            continue
        inbound["settings"]["clients"] = clients.get(inbound["tag"], [])
    routing = runtime.setdefault("routing", {})
    routing["rules"] = routing.get("rules", []) + rules
    return runtime, warnings
