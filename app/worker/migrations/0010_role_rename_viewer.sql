-- Renames the "reader" RBAC role to "viewer" (direct instruction).
-- repo_roles.role has a CHECK constraint, and SQLite can't ALTER a
-- CHECK -- unlike ladder_index (migration 0009), this table isn't a
-- freely-regenerable cache (there's no bulk-rebuild-from-source-of-
-- truth function for it), so this preserves data via rename+copy
-- instead of drop+recreate, translating any existing 'reader' rows
-- to 'viewer' rather than losing them.
ALTER TABLE repo_roles RENAME TO repo_roles_old;

CREATE TABLE repo_roles (
  repo_slug TEXT NOT NULL REFERENCES repos(slug),
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'contributor', 'viewer')),
  granted_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_slug, principal)
);

INSERT INTO repo_roles (repo_slug, principal, role, granted_by, at)
  SELECT repo_slug, principal, CASE WHEN role = 'reader' THEN 'viewer' ELSE role END, granted_by, at
  FROM repo_roles_old;

DROP TABLE repo_roles_old;

CREATE INDEX idx_repo_roles_principal ON repo_roles(principal);
