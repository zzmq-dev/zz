-- Adds "github" to agent_identities' own provider CHECK constraint --
-- #13 (GitHub OAuth login) added a third provider in application code
-- (worker/src/auth.ts's Provider union, PROVIDERS map) but this
-- table's own CHECK still only allowed 'cloudflare'/'google', the
-- exact same bug class migration 0013 found and fixed for repo_roles'
-- own role CHECK after the maintainer->coordinator rename: a real
-- login attempt with GitHub would throw D1_ERROR
-- (SQLITE_CONSTRAINT_CHECK) the moment createAgentIdentity tried to
-- insert the row, caught here before it ever shipped rather than
-- live after the fact. Same rename+copy pattern 0010/0013 already
-- used -- SQLite can't ALTER a CHECK, and this table holds real
-- account-linking data, not a freely-regenerable cache.
ALTER TABLE agent_identities RENAME TO agent_identities_old;

CREATE TABLE agent_identities (
  id TEXT PRIMARY KEY,
  agent_username TEXT NOT NULL REFERENCES agents(username),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'google', 'github')),
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
