"""Tests for the user models, the uuid rule, and the user service.

Uses the standard library's unittest so there are no extra dependencies.
The db CRUD layer's raw SQL round-trips live in tests/test_db.py; this
file pins what the API accepts and the business rules (uuid stability,
authoritative access updates). Mutations only write rows — agents
converge on their next heartbeat, nothing is pushed (M3).
"""

import unittest

from pydantic import ValidationError

from models import AccessIn, UserCreate, UserUpdate
from services import user_service
from tests.support import cleanup_db, open_fresh_db_sync


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


class TestUserService(unittest.IsolatedAsyncioTestCase):
    """Create/update/delete rules; nothing is pushed (M3 pull model)."""

    def setUp(self):
        self.conn, self.path = open_fresh_db_sync()
        self.addCleanup(cleanup_db, self.conn, self.path)

    def _access(self, inbounds=(), outbounds=()):
        """Build one AccessIn payload section."""
        return AccessIn(
            allowed_inbounds=list(inbounds), allowed_outbounds=list(outbounds)
        )

    async def test_create_writes_access_rows(self):
        created = await user_service.create_user(self.conn, UserCreate(
            username="bob",
            access={"tokyo01": self._access(["reality"], ["jijiguo"])},
        ))

        stored = await user_service.get_user_with_access(self.conn, "bob")
        self.assertEqual(
            set(stored["access"]["tokyo01"]["uuids"]), {"jijiguo"}
        )
        self.assertEqual(
            created["access"]["tokyo01"]["allowed_inbounds"], ["reality"]
        )

    async def test_create_with_no_access_writes_no_rows(self):
        await user_service.create_user(self.conn, UserCreate(username="bob"))

        stored = await user_service.get_user_with_access(self.conn, "bob")
        self.assertEqual(stored["access"], {})

    async def test_update_merges_fields_and_keeps_uuids_stable(self):
        created = await user_service.create_user(self.conn, UserCreate(
            username="bob",
            access={"tokyo01": self._access(["reality"], ["jijiguo"])},
        ))

        updated = await user_service.update_user(
            self.conn, "bob", UserUpdate(note="new")
        )

        self.assertEqual(updated["note"], "new")
        self.assertEqual(
            updated["access"], created["access"]
        )

    async def test_update_with_access_adds_exactly_one_new_uuid(self):
        created = await user_service.create_user(self.conn, UserCreate(
            username="bob",
            access={"tokyo01": self._access([], ["jijiguo"])},
        ))

        await user_service.update_user(self.conn, "bob", UserUpdate(access={
            "tokyo01": self._access([], ["jijiguo", "caibeiguo"]),
        }))

        updated = await user_service.get_user_with_access(self.conn, "bob")
        uuids = updated["access"]["tokyo01"]["uuids"]
        self.assertEqual(uuids["jijiguo"], created["access"]["tokyo01"]["uuids"]["jijiguo"])
        self.assertIn("caibeiguo", uuids)

    async def test_update_access_map_is_authoritative_membership(self):
        """Nodes left out of a provided map lose their row."""
        await user_service.create_user(self.conn, UserCreate(username="bob"))

        await user_service.update_user(self.conn, "bob", UserUpdate(access={
            "tokyo01": self._access(), "toyama01": self._access(),
        }))
        await user_service.update_user(self.conn, "bob", UserUpdate(access={
            "tokyo01": self._access(),
        }))

        access = await user_service.get_user_with_access(self.conn, "bob")
        self.assertEqual(set(access["access"]), {"tokyo01"})

    async def test_update_with_none_access_leaves_rows_alone(self):
        await user_service.create_user(self.conn, UserCreate(username="bob"))
        await user_service.update_user(self.conn, "bob", UserUpdate(access={
            "tokyo01": self._access(),
        }))

        await user_service.update_user(self.conn, "bob", UserUpdate(note="x"))

        access = await user_service.get_user_with_access(self.conn, "bob")
        self.assertIn("tokyo01", access["access"])

    async def test_update_missing_user_returns_none(self):
        self.assertIsNone(
            await user_service.update_user(self.conn, "ghost", UserUpdate(note="x"))
        )

    async def test_delete_reports_existence(self):
        await user_service.create_user(self.conn, UserCreate(username="bob"))
        await user_service.update_user(self.conn, "bob", UserUpdate(access={
            "tokyo01": self._access(), "toyama01": self._access(),
        }))

        self.assertTrue(await user_service.delete_user(self.conn, "bob"))
        self.assertFalse(await user_service.delete_user(self.conn, "bob"))


if __name__ == "__main__":
    unittest.main()
