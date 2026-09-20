"""The heartbeat cheap-write rule, without any environment.

Pure function: `should_touch` compares a stored row with desired values,
so it runs identically under any Python.
"""

import unittest

from services import node_state_service


class TestShouldTouch(unittest.TestCase):
    """The heartbeat cheap-write rule."""

    def _node(self, **overrides):
        """A stored row with boring defaults."""
        row = {
            "last_seen": 1000, "health": "ok", "agent_version": "0.1.0",
            "xray_version": "25.1.1", "last_error": None,
            "applied_hash": "abc",
        }
        row.update(overrides)
        return row

    def _values(self, **overrides):
        """Desired values identical to the stored row by default."""
        values = {
            "last_seen": 1000, "health": "ok", "agent_version": "0.1.0",
            "xray_version": "25.1.1", "last_error": None,
            "applied_hash": "abc",
        }
        values.update(overrides)
        return values

    def test_first_contact_always_writes(self):
        self.assertTrue(node_state_service.should_touch(
            self._node(last_seen=None), self._values(), 1000))

    def test_stale_liveness_writes(self):
        self.assertTrue(node_state_service.should_touch(
            self._node(last_seen=1000), self._values(), 1061))

    def test_fresh_identical_heartbeat_skips(self):
        self.assertFalse(node_state_service.should_touch(
            self._node(last_seen=1000), self._values(), 1059))

    def test_changed_fact_writes_even_when_fresh(self):
        self.assertTrue(node_state_service.should_touch(
            self._node(last_seen=1000),
            self._values(applied_hash="def"), 1001))


if __name__ == "__main__":
    unittest.main()
