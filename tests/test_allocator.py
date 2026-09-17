"""Tests for the copied allocator: pure dict in, pure dict out.

Run from the repo root:
    python -m unittest tests.test_allocator -v
"""

import unittest

from core import allocator


class TestAllocate(unittest.TestCase):
    def test_clients_per_inbound(self):
        permissions = {
            "alice": {
                "allowed_inbounds": ["REALITY"],
                "allowed_outbounds": ["OUTBOUND"],
            },
        }
        inbounds = [{"tag": "REALITY", "protocol": "vless"}]
        uuids = {"alice@OUTBOUND": "uuid-1"}

        clients, _, warnings = allocator.allocate(
            permissions, inbounds, ["OUTBOUND"], uuids
        )

        self.assertEqual(
            clients,
            {"REALITY": [{"id": "uuid-1", "email": "alice@OUTBOUND"}]},
        )
        self.assertEqual(warnings, [])

    def test_routing_rule_per_outbound(self):
        _, rules, _ = allocator.allocate({}, [], ["OUTBOUND", "BLOCK"], {})

        self.assertEqual(
            rules,
            [
                {"user": ["regexp:.*@OUTBOUND$"], "outboundTag": "OUTBOUND"},
                {"user": ["regexp:.*@BLOCK$"], "outboundTag": "BLOCK"},
            ],
        )

    def test_non_vless_inbound_skipped_with_warning(self):
        permissions = {
            "alice": {"allowed_inbounds": ["DNS"], "allowed_outbounds": ["OUTBOUND"]},
        }
        inbounds = [{"tag": "DNS", "protocol": "dokodemo-door"}]
        uuids = {"alice@OUTBOUND": "uuid-1"}

        clients, _, warnings = allocator.allocate(
            permissions, inbounds, ["OUTBOUND"], uuids
        )

        self.assertEqual(clients, {})
        self.assertIn("skipping non-vless inbound 'DNS'", warnings)

    def test_missing_uuid_warns(self):
        permissions = {
            "alice": {"allowed_inbounds": ["REALITY"],
                      "allowed_outbounds": ["OUTBOUND"]},
        }
        inbounds = [{"tag": "REALITY", "protocol": "vless"}]

        clients, _, warnings = allocator.allocate(
            permissions, inbounds, ["OUTBOUND"], {}
        )

        self.assertEqual(clients, {})
        self.assertIn("missing uuid for 'alice@OUTBOUND'", warnings)


if __name__ == "__main__":
    unittest.main()
