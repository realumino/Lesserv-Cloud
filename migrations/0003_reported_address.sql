-- The agent-reported public address, display-only.
--
-- enroll already carried `detected_ip` (protocol 1) but stored it nowhere.
-- This column records the node's own view of its public address — from the
-- agent's report, or from the edge-observed connection IP when the agent
-- sends none. It never feeds share links: the advertised host is the
-- admin-set `address` (domain), so clients never receive a bare IP the
-- admin did not choose.
ALTER TABLE nodes ADD COLUMN reported_address TEXT;
