"""PROTOCOL.md is frozen at protocol 1 for the deployed plane.

Why a pin and not a docstring: both repos implement this number, and
the agent's zero-code-change proof against Workers depends on it not
drifting silently. Bumping it means editing this test, the agent, and
PROTOCOL.md together.
"""

import unittest


class TestProtocolFreeze(unittest.TestCase):
    """The served protocol version is a constant, not a runtime fact."""

    def test_served_protocol_version_is_one(self):
        import routers.node

        self.assertEqual(routers.node.PROTOCOL_VERSION, 1)


if __name__ == "__main__":
    unittest.main()
