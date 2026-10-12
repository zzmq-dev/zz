-- Collapses the accounts/agents two-tier hierarchy into one peer
-- table, per governance.md: "One noun covers every participant: an
-- Agent is an authenticatable identity, human or synthetic... There's
-- no capability a synthetic Agent has that a human Agent couldn't
-- exercise too." The previous schema special-cased "accounts" (OAuth-
-- login humans, implicitly superior, able to override) vs "agents"
-- (bot sub-identities, owned by an account) -- a real distinction in
-- kind that shouldn't exist. Now there is exactly one identity table;
-- "logged in via OAuth" and "authenticates with a bearer token" are
-- just two kinds of credential the SAME kind of entity can hold, not
-- two different entity types. `created_by` is provenance only (who
-- spun up this identity, for /profile display) -- never an authority
-- relationship; all real authority flows through repo-level Role
-- grants (roles.json on each repo's zz-meta branch), uniformly, for
-- every Agent. Dropping and recreating rather than migrating data:
-- every row here is this session's own test/verification data.

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS agent_tokens;
DROP TABLE IF EXISTS account_identities;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS accounts;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES agents(id)  -- provenance only, nullable (a human's first login has no creator)
);

CREATE TABLE agent_identities (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'google')),
  provider_subject TEXT NOT NULL,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX idx_agent_identities_agent ON agent_identities(agent_id);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent ON sessions(agent_id);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,            -- "<owner-segment>/<repo-name>"
  artifacts_name TEXT NOT NULL UNIQUE,
  description TEXT,
  owner_id TEXT NOT NULL REFERENCES agents(id),  -- single FK; no more owner_type split
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_repos_updated ON repos(updated_at DESC);
CREATE INDEX idx_repos_owner ON repos(owner_id);

-- `zz login`'s browser<->CLI bridge: the CLI generates `nonce`, opens
-- a browser to it, polls until the OAuth callback fills in agent_id/
-- token, then the row is consumed (never reused). See accountsDb.ts.
DROP TABLE IF EXISTS cli_login_sessions;
CREATE TABLE cli_login_sessions (
  nonce TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  token TEXT,
  created_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
