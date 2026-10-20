-- #26: retires the bracket-chained username scheme (`computeUsername`'s
-- "<creator>[<name>]" for a managed agent, a bare email for a human)
-- entirely. `username` is now the literal did:guardian identifier
-- itself (e.g. "did:guardian:alice:zzmq.dev") -- the canonical identity
-- for every lookup, foreign key, and URL; the "<name>@<domain>"
-- email-shaped form is a pure rendering (formatAgentId), used only for
-- display and mail, never stored.
--
-- `guardian_did` (added in #23, migration 0016) is dropped: once
-- `username` *is* the DID, every creation path sets both to the same
-- value, making it a second, always-redundant copy of the same fact.
--
-- Same "drop and recreate" pattern as migration 0006, for the same
-- reason: every row in these tables is this integration's own test
-- data (confirmed directly, not assumed), so there is nothing to
-- migrate forward -- recreating fresh carries over every change made
-- since 0006 (the `github` provider value, the `coordinator`/`viewer`
-- role values, `named_at`) minus `guardian_did`, rather than layering
-- another ALTER TABLE onto a column that's about to mean something
-- different anyway.
DROP TABLE IF EXISTS repo_roles;
DROP TABLE IF EXISTS repo_tracking;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS agent_tokens;
DROP TABLE IF EXISTS agent_identities;
DROP TABLE IF EXISTS cli_login_sessions;
DROP TABLE IF EXISTS agents;

CREATE TABLE agents (
  username TEXT PRIMARY KEY,  -- the literal did:guardian identifier, e.g. "did:guardian:alice:zzmq.dev" -- see guardianspec.org's own spec for the format. Never bracket-chained, never a bare email; display/mail use the separate "<name>@<domain>" rendering (webApp.ts's formatAgentId), not this column.
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES agents(username)  -- provenance only, nullable (a human's first login has no creator)
);

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
CREATE INDEX idx_agent_identities_agent ON agent_identities(agent_username);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  agent_username TEXT NOT NULL REFERENCES agents(username),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_username);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_username TEXT NOT NULL REFERENCES agents(username),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent ON sessions(agent_username);

CREATE TABLE repos (
  slug TEXT PRIMARY KEY,
  artifacts_name TEXT NOT NULL UNIQUE,
  description TEXT,
  owner_username TEXT NOT NULL REFERENCES agents(username),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  shard_of_slug TEXT REFERENCES repos(slug),
  ingest_status TEXT NOT NULL DEFAULT 'ready' CHECK (ingest_status IN ('ready', 'ingesting')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_repos_updated ON repos(updated_at DESC);
CREATE INDEX idx_repos_owner ON repos(owner_username);
CREATE INDEX idx_repos_shard_of ON repos(shard_of_slug);

CREATE TABLE repo_roles (
  repo_slug TEXT NOT NULL REFERENCES repos(slug),
  principal TEXT NOT NULL,  -- an agent's username (now a did:guardian string)
  role TEXT NOT NULL CHECK (role IN ('owner', 'coordinator', 'contributor', 'viewer')),
  granted_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_slug, principal)
);
CREATE INDEX idx_repo_roles_principal ON repo_roles(principal);

CREATE TABLE cli_login_sessions (
  nonce TEXT PRIMARY KEY,
  agent_username TEXT REFERENCES agents(username),
  token TEXT,
  created_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

-- "Track this repo" -- added in migration 0011, after 0006's own
-- recreate; carried forward here unchanged (missed on the first pass
-- of this migration, caught by a real FOREIGN KEY constraint failure
-- applying it live -- D1 genuinely enforces these, same lesson
-- migration 0015's own header already recorded).
CREATE TABLE repo_tracking (
  username TEXT NOT NULL REFERENCES agents(username),
  repo_slug TEXT NOT NULL REFERENCES repos(slug),
  tracked_at TEXT NOT NULL,
  PRIMARY KEY (username, repo_slug)
);
CREATE INDEX idx_repo_tracking_slug ON repo_tracking(repo_slug);
