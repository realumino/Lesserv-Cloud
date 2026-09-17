"""Pydantic models describing the shapes of data entering and leaving the API.

Why this exists: without models, endpoints must trust whatever JSON
arrives. With models, FastAPI validates input (bad data becomes a 422
with a clear error message), documents the shapes, and guarantees the
services never see malformed data.

The node dimension appears where it belongs: a user's payload carries a
nested `access` map keyed by node id, and the server generates the uuids
inside each per-node entry — the admin never types a qualified name and
never sees storage details.
"""

import re
from typing import Literal

from pydantic import BaseModel, StrictInt, StrictStr, field_validator

_NODE_ID_PATTERN = re.compile(r"[a-z0-9]{1,32}")
_PROFILE_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
LINK_PROFILE_OVERRIDE_KEYS = frozenset({
    "address",
    "alpn",
    "fp",
    "host",
    "mode",
    "path",
    "port",
    "security",
    "serviceName",
    "sni",
})


def _validate_overrides(value):
    """Check one profile override map against the supported URI inputs."""
    if not isinstance(value, dict):
        raise ValueError("overrides must be an object")
    for key, item in value.items():
        if key not in LINK_PROFILE_OVERRIDE_KEYS:
            raise ValueError(f"unsupported override '{key}'")
        if isinstance(item, bool) or not isinstance(item, (str, int)):
            raise ValueError(f"override '{key}' must be text or a number")
    return value


class NodeCreate(BaseModel):
    """The JSON body for POST /api/admin/nodes."""

    id: str
    label: str
    address: str = ""

    @field_validator("id")
    @classmethod
    def id_is_plain_local_name(cls, value):
        """Reject ids that would break the qualified-tag scheme.

        Why: tags are qualified as `{tag}-{node_id}` and
        `{node_id}-{tag}`; the hyphen separator must never appear inside
        a node id. Lowercase alphanumerics keep qualified tags, emails,
        and logs readable.
        """
        value = value.strip()
        if not _NODE_ID_PATTERN.fullmatch(value):
            raise ValueError("node id must be 1-32 lowercase letters or digits")
        return value

    @field_validator("label")
    @classmethod
    def label_not_blank(cls, value):
        """Reject an empty label: it is the human-readable name everywhere."""
        value = value.strip()
        if not value:
            raise ValueError("label must not be empty")
        return value


class NodeUpdate(BaseModel):
    """The JSON body for PUT /api/admin/nodes/{node_id}.

    Why every field is optional: partial update — None means "leave
    unchanged". No `id`: the id is the identity and cannot be renamed
    via update.
    """

    label: str | None = None
    address: str | None = None


class NodeOut(BaseModel):
    """The JSON the API returns for one node.

    Why has_config: a list view must learn which nodes have a config
    without fetching every config blob.
    """

    id: str
    label: str
    address: str
    created_at: int
    has_config: bool


class LinkProfileIn(BaseModel):
    """The JSON body for POST /api/admin/nodes/{node_id}/link-profiles."""

    id: str
    inbound_tag: str
    label: str
    overrides: dict[str, StrictStr | StrictInt] = {}

    @field_validator("id")
    @classmethod
    def id_is_node_scoped_slug(cls, value):
        """Keep profile ids short, stable, and safe in API paths."""
        value = value.strip()
        if not _PROFILE_ID_PATTERN.fullmatch(value):
            raise ValueError(
                "profile id must start with a letter or digit and contain "
                "only lowercase letters, digits, or hyphens"
            )
        return value

    @field_validator("inbound_tag", "label")
    @classmethod
    def text_is_present(cls, value):
        """Reject blank inbound attachments and display names."""
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

    @field_validator("overrides")
    @classmethod
    def overrides_are_supported(cls, value):
        """Restrict overrides to supported client-visible URI inputs."""
        return _validate_overrides(value)


class LinkProfileUpdate(BaseModel):
    """The JSON body for PUT .../link-profiles/{profile_id}.

    Why every editable field is optional: None means unchanged. Identity
    fields are never renamed through an update.
    """

    inbound_tag: str | None = None
    label: str | None = None
    overrides: dict[str, StrictStr | StrictInt] | None = None

    @field_validator("inbound_tag", "label")
    @classmethod
    def text_is_present_when_provided(cls, value):
        """Reject a blank value without changing None-means-unchanged."""
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

    @field_validator("overrides")
    @classmethod
    def overrides_are_supported_when_provided(cls, value):
        """Validate overrides only when the update supplies them."""
        if value is None:
            return value
        return _validate_overrides(value)


class LinkProfileOut(BaseModel):
    """The JSON the API returns for one link profile."""

    id: str
    inbound_tag: str
    label: str
    overrides: dict[str, StrictStr | StrictInt]
    created_at: int


class AccessIn(BaseModel):
    """One node's section of a user's access payload.

    Why lists and not the uuid map: uuids are server-generated facts;
    the client only chooses which local inbounds and outbounds are
    allowed.
    """

    allowed_inbounds: list[str] = []
    allowed_outbounds: list[str] = []


class UserCreate(BaseModel):
    """The JSON body for POST /api/admin/users."""

    username: str
    status: Literal["active", "disabled"] = "active"
    expire: int | None = None
    note: str | None = None
    access: dict[str, AccessIn] = {}

    @field_validator("username")
    @classmethod
    def username_is_safe(cls, value):
        """Reject usernames that would break the username@outbound email scheme.

        Why: Xray client emails are built as "username@outboundtag" and
        the routing rules match on them, so an '@' or a space inside the
        username would corrupt routing. Length is capped so emails stay
        sane. (Copied from the archived panel.)
        """
        value = value.strip()
        if not value:
            raise ValueError("username must not be empty")
        if "@" in value or " " in value:
            raise ValueError("username must not contain '@' or spaces")
        if len(value) > 32:
            raise ValueError("username must be at most 32 characters")
        return value


class UserUpdate(BaseModel):
    """The JSON body for PUT /api/admin/users/{username}.

    Why access is optional: None means "leave access unchanged"; a
    provided map is the complete desired membership — nodes left out of
    it lose their row (the admin form submits every per-node section).
    """

    status: Literal["active", "disabled"] | None = None
    expire: int | None = None
    note: str | None = None
    access: dict[str, AccessIn] | None = None


class AccessOut(BaseModel):
    """One node's section of a user's response, with server-generated uuids."""

    allowed_inbounds: list[str]
    allowed_outbounds: list[str]
    uuids: dict[str, str]


class UserOut(BaseModel):
    """The JSON the API returns for one user.

    Why access is nested by node: membership is per-node stored data;
    the admin sees exactly the shape they edit.
    """

    username: str
    status: str
    expire: int | None
    note: str | None
    created_at: int
    access: dict[str, AccessOut]


class ShareLink(BaseModel):
    """One generated VLESS share link, carrying its own node."""

    node: str
    inbound: str
    outbound: str
    email: str
    profile: str | None = None
    label: str | None = None
    uri: str


class UserLinksOut(BaseModel):
    """Response for GET /api/admin/users/{username}/links."""

    username: str
    links: list[ShareLink]
    warnings: list[str]
