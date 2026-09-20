"""Tests for the user models and the uuid rule.

Pure functions only: pydantic validation and `ensure_uuids` take plain
values and return plain values, so they run identically under any
Python. The service-level rules that need a database are covered over
HTTP in tests/workerd/test_admin_users.py.
"""

import unittest

from pydantic import ValidationError

from models import UserCreate, UserUpdate
from services import user_service


class TestUserCreateModel(unittest.TestCase):
    """Body validation, copied from the archived panel's rules."""

    def test_valid_username_and_defaults(self):
        user = UserCreate(username="alice")

        self.assertEqual(user.username, "alice")
        self.assertEqual(user.status, "active")
        self.assertEqual(user.access, {})
        self.assertIsNone(user.expire)
        self.assertIsNone(user.note)

    def test_access_defaults_to_no_membership(self):
        user = UserCreate(username="alice", access={
            "tokyo01": {"allowed_inbounds": ["reality"]},
        })

        self.assertEqual(user.access["tokyo01"].allowed_inbounds, ["reality"])
        self.assertEqual(user.access["tokyo01"].allowed_outbounds, [])

    def test_username_with_at_is_rejected(self):
        with self.assertRaises(ValidationError):
            UserCreate(username="ali@ce")

    def test_blank_username_is_rejected(self):
        with self.assertRaises(ValidationError):
            UserCreate(username="   ")

    def test_long_username_is_rejected(self):
        with self.assertRaises(ValidationError):
            UserCreate(username="a" * 33)

    def test_bad_status_is_rejected(self):
        with self.assertRaises(ValidationError):
            UserCreate(username="alice", status="banned")


class TestUserUpdateModel(unittest.TestCase):
    """Partial-update semantics: None means "leave unchanged"."""

    def test_all_fields_optional(self):
        update = UserUpdate()

        self.assertIsNone(update.status)
        self.assertIsNone(update.expire)
        self.assertIsNone(update.note)
        self.assertIsNone(update.access)

    def test_access_is_a_map_or_none(self):
        update = UserUpdate(access={})

        self.assertEqual(update.access, {})


class TestEnsureUuids(unittest.TestCase):
    """The archived uuid rule, now keyed by local outbound tag."""

    def test_creates_one_uuid_per_outbound(self):
        uuids = user_service.ensure_uuids(["jijiguo", "caibeiguo"], {})

        self.assertEqual(set(uuids), {"jijiguo", "caibeiguo"})

    def test_existing_uuids_are_stable(self):
        first = user_service.ensure_uuids(["jijiguo"], {})
        second = user_service.ensure_uuids(["jijiguo"], first)

        self.assertEqual(first, second)

    def test_new_outbound_only_adds_new_uuid(self):
        first = user_service.ensure_uuids(["jijiguo"], {})
        second = user_service.ensure_uuids(["jijiguo", "caibeiguo"], first)

        self.assertEqual(first["jijiguo"], second["jijiguo"])
        self.assertIn("caibeiguo", second)


if __name__ == "__main__":
    unittest.main()
