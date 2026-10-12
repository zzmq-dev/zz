-- A D1-side cache of each repo's roles.json grants (source of truth
-- stays the zz-meta branch -- see repoMeta.ts/architecture/index.md's
-- warning against D1 becoming load-bearing). Needed because "repos
-- you have a role on" is a cross-repo query (the profile page), and
-- there's no affordable way to answer that by walking every repo's
-- own orphan branch on every page load -- same reasoning the `repos`
-- table itself already documents for why it exists as an index.
-- Kept in sync by doRbacGrant (webApp.ts) on every grant/role change;
-- one row per (repo, principal), since a principal has exactly one
-- current grant per repo at any time (roles.json itself only ever
-- keeps the latest).
CREATE TABLE repo_roles (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'contributor', 'reader')),
  granted_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_id, principal)
);
CREATE INDEX idx_repo_roles_principal ON repo_roles(principal);
