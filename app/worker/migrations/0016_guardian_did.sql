-- #23: links an agent to its real did:guardian identity, registered
-- against zz's own registrar instance (id.zzmq.dev). Additive only --
-- null for every agent created before this migration; no backfill in
-- this pass. Registered ownerless for now -- establishing created_by
-- as a real, signed guardian relationship needs a registrar endpoint
-- that doesn't exist yet (see guardianClient.ts's own header).
ALTER TABLE agents ADD COLUMN guardian_did TEXT;
