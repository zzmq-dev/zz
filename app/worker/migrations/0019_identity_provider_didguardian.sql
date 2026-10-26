-- Adds "didguardian" to agent_identities' own provider CHECK constraint --
-- same bug class migration 0014 fixed for github: zz is about to start
-- persisting the access/refresh token from a did:guardian OIDC login
-- (previously discarded immediately after the /userinfo call, see
-- guardianOidc.ts's own exchangeGuardianCode) so it can mint a fresh
-- access token later for the managed-identity-creation flow, without a
-- CHECK constraint rejecting the insert the moment it's tried. Same
-- rename+copy pattern 0014 already used -- SQLite can't ALTER a CHECK,
-- and this table holds real account-linking data, not a freely-
-- regenerable cache.

ALTER TABLE agent_identities RENAME TO agent_identities_old;

CREATE TABLE agent_identities (
  id TEXT PRIMARY KEY,
  agent_username TEXT NOT NULL REFERENCES agents(username),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'google', 'github', 'didguardian')),
  provider_subject TEXT NOT NULL,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);

INSERT INTO agent_identities (id, agent_username, provider, provider_subject, access_token_enc, refresh_token_enc, token_expires_at, created_at)
  SELECT id, agent_username, provider, provider_subject, access_token_enc, refresh_token_enc, token_expires_at, created_at
  FROM agent_identities_old;

DROP TABLE agent_identities_old;

CREATE INDEX idx_agent_identities_agent ON agent_identities(agent_username);
