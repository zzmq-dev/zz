-- Accounts/RBAC + repo index (site/content/competition-plan's web-app
-- deliverable). D1 is an index/cache here, not the source of truth for
-- repo metadata -- that lives on each repo's own zz-meta orphan branch
-- (app/worker/src/repoMeta.ts). accounts/agents/tokens/sessions have no
-- git home, so D1 is authoritative for those.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE account_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'google')),
  provider_subject TEXT NOT NULL,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX idx_account_identities_account ON account_identities(account_id);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agents_account ON agents(account_id);

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
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_account ON sessions(account_id);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,            -- "account/repo-name"
  artifacts_name TEXT NOT NULL UNIQUE,  -- underlying Cloudflare Artifacts repo name
  description TEXT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('account', 'agent')),
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_repos_updated ON repos(updated_at DESC);
CREATE INDEX idx_repos_owner ON repos(owner_type, owner_id);
