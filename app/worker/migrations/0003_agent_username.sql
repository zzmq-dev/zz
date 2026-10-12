-- Adds a frozen `username` (the public /<username> URL segment: an
-- Agent's email, or a slugified display name) -- previously
-- recomputed live from display_name on every request
-- (webApp.ts's old ownerUrlSegment()), which meant changing your
-- display name later would silently break every repo slug already
-- built from the old computed value. Stored once at creation instead,
-- like a real username (see accountsDb.ts's createAgent).
--
-- Backfill for the 3 agents that exist as of this migration mirrors
-- the exact value ownerUrlSegment() used to compute live (email if
-- present, else a slugified display_name), so existing repo slugs
-- keep resolving unchanged.
ALTER TABLE agents ADD COLUMN username TEXT;

UPDATE agents SET username = email WHERE email IS NOT NULL;
UPDATE agents SET username = lower(display_name) WHERE email IS NULL;
UPDATE agents SET username = replace(username, ' ', '-') WHERE email IS NULL;

CREATE UNIQUE INDEX idx_agents_username ON agents(username);
