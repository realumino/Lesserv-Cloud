"""Readable display names for tags, nodes, profiles, and generated links.

Why this exists: qualified machine names (`reality-tokyo01`) are unambiguous
but unfriendly. Display names combine stored labels for nodes and profiles
with prettified local tags, so an admin and an end user see readable text
without ever storing display state that can rot when a config changes.
"""

import re

_ACRONYMS = frozenset({
    "grpc",
    "http",
    "httpupgrade",
    "in",
    "reality",
    "tls",
    "trojan",
    "vless",
    "vmess",
    "ws",
    "xhttp",
})


def _display_word(word) -> str:
    """Return one tag word in display case, preserving known acronyms."""
    if not word:
        return ""
    lowered = word.lower()
    if lowered in _ACRONYMS:
        return lowered.upper()
    return word[:1].upper() + word[1:].lower()


def pretty_tag(tag) -> str:
    """Return a readable display name for one local tag.

    Why separators are normalized: local tags use hyphens or underscores as
    word separators. Display names use spaces, title casing, and uppercase
    transport/security acronyms (`xhttp` becomes `XHTTP`, `niigata` becomes
    `Niigata`).
    """
    if not isinstance(tag, str):
        return ""
    words = [word for word in re.split(r"[-_]+", tag.strip()) if word]
    return " ".join(_display_word(word) for word in words)


def link_label(node_label, subject_label, outbound_label) -> str:
    """Return the readable label for one generated link.

    Why this order: the node is the fleet context, the subject is either the
    prettified inbound or a stored profile label, and the exit is last. The
    result is cosmetic only; routing and accounting use qualified names.
    """
    return f"{node_label} · {subject_label} → {outbound_label}"
