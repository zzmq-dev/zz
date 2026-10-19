-- Renames the "maintainer" RBAC role to "coordinator" in the D1 cache
-- table -- the application-code rename (commit 06455c6, "Retire
-- Maintainer, collapse to Coordinator") updated RbacRole's TypeScript
-- union (repoMeta.ts) and every call site, but never touched this
-- table's own CHECK constraint, which still only allowed 'maintainer'.
-- Silent until now: every grant of role "coordinator" since that
-- rename has thrown D1_ERROR (SQLITE_CONSTRAINT_CHECK) inside
-- syncRepoRoleCache, caught only by re-running the governance demo
-- while verifying unrelated Tier 1 work -- confirmed live, reproducible,
-- "Worker threw exception" on every `zz repo role grant ... coordinator`
-- and the web app's own role-grant form.
--
-- Same reasoning and same rename+copy pattern as migration 0010 (which
-- did this for "reader" -> "viewer"): SQLite can't ALTER a CHECK, and
-- this table isn't a freely-regenerable cache, so existing rows are
-- translated rather than lost.
ALTER TABLE repo_roles RENAME TO repo_roles_old;

CREATE TABLE repo_roles (
  repo_slug TEXT NOT NULL REFERENCES repos(slug),
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'coordinator', 'contributor', 'viewer')),
  granted_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_slug, principal)
);

INSERT INTO repo_roles (repo_slug, principal, role, granted_by, at)
  SELECT repo_slug, principal, CASE WHEN role = 'maintainer' THEN 'coordinator' ELSE role END, granted_by, at
  FROM repo_roles_old;

DROP TABLE repo_roles_old;

CREATE INDEX idx_repo_roles_principal ON repo_roles(principal);
