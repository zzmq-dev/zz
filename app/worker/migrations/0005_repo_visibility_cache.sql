-- A D1-side cache of each repo's meta.json policy.visibility (source of
-- truth stays zz-meta, same reasoning as repo_roles in migration 0004)
-- -- needed so /explore and search can filter out private repos for
-- viewers without access WITHOUT reading every repo's orphan branch on
-- every listing request. Kept in sync by doCreateRepo/doSetVisibility.
-- Defaults to 'public' to match ensureMeta's own default policy.
ALTER TABLE repos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private'));
