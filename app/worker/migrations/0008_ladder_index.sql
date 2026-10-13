-- A full-text index over Ladder rung summaries, across every repo --
-- "ecosystem-wide intelligence" needs to be findable, not just
-- generated. Keyed by artifacts_name (the DO's own identity, what it
-- actually has on hand when writing a rung), not slug -- search-time
-- queries join against repos to resolve slug/visibility, same split
-- as repos.artifacts_name vs repos.slug everywhere else.
-- Only "file" and "repo" kind rungs get indexed (see
-- cloudflareBackend.ts's writeLadder) -- those are the ones holding a
-- holistic, current-state summary of what something actually does;
-- "changeset"/"filechange" are historical per-commit entries, not
-- reusable-code descriptions, and would just churn the index on every
-- commit.
CREATE VIRTUAL TABLE ladder_index USING fts5(
  artifacts_name UNINDEXED,
  path UNINDEXED,
  kind UNINDEXED,
  summary
);
