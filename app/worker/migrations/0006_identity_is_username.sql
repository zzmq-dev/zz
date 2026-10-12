-- Drops the separate opaque `id` on both agents and repos -- per
-- direct instruction, after tracing through why it existed: `id`
-- predates `username`/`slug` entirely (the only identifier when
-- agents were first modeled), and `username`/`slug` got bolted on
-- later purely as a *display* layer rather than replacing it. Once
-- both are unique (DB constraint) and immutable (frozen at creation,
-- never recomputed -- migration 0003's whole point for usernames;
-- slugs already worked this way from the start), there's no remaining
-- reason for a second id behind them. Having both was exactly the
-- "two sources of truth for the same thing" bug class this session
-- kept finding (the stale "groq-test" principal, the agentId-vs-
-- username mixup setting up a manual credentials file) -- so instead
-- of migrating the old ids forward, this drops and recreates
-- everything, same as migration 0002 did for the same reason:
-- "every row here is this session's own test/verification data."
-- Existing Artifacts repos (shoes, numkit) are deleted out of band
-- (wrangler artifacts repos delete) since their committed
-- roles.json/meta.json reference the old agent ids directly and
-- there's nothing worth preserving in them.
DROP TABLE IF EXISTS repo_roles;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS agent_tokens;
DROP TABLE IF EXISTS agent_identities;
DROP TABLE IF EXISTS cli_login_sessions;
DROP TABLE IF EXISTS agents;

CREATE TABLE agents (
  username TEXT PRIMARY KEY,  -- a human's real email; a managed agent's "<creator's username>[<name>]" (accountsDb.ts's computeUsername)
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES agents(username)  -- provenance only, nullable (a human's first login has no creator)
);

CREATE TABLE agent_identities (
  id TEXT PRIMARY KEY,  -- an identity row has no natural key of its own besides (provider, provider_subject), which is already the real uniqueness constraint below -- this stays a plain surrogate key since nothing else ever references an identity row by id
  agent_username TEXT NOT NULL REFERENCES agents(username),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'google')),
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
  slug TEXT PRIMARY KEY,  -- "<owner username>/<repo name>" -- frozen at creation (doCreateRepo), same immutability argument as agents.username
  artifacts_name TEXT NOT NULL UNIQUE,  -- NOT redundant with slug: this is the key into Cloudflare's own Artifacts namespace, a different system, deliberately decoupled from the slug
  description TEXT,
  owner_username TEXT NOT NULL REFERENCES agents(username),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_repos_updated ON repos(updated_at DESC);
CREATE INDEX idx_repos_owner ON repos(owner_username);

-- D1-side cache of each repo's roles.json grants (source of truth
-- stays the zz-meta branch) -- see migration 0004's original header.
CREATE TABLE repo_roles (
  repo_slug TEXT NOT NULL REFERENCES repos(slug),
  principal TEXT NOT NULL,  -- an agent's username -- same field, same meaning, just no longer a separate opaque id
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'contributor', 'reader')),
  granted_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_slug, principal)
);
CREATE INDEX idx_repo_roles_principal ON repo_roles(principal);

-- `zz login`'s browser<->CLI bridge -- unchanged shape, just points at
-- a username instead of an id now.
CREATE TABLE cli_login_sessions (
  nonce TEXT PRIMARY KEY,
  agent_username TEXT REFERENCES agents(username),
  token TEXT,
  created_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
