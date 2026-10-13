-- Adds commit_sha so a Ladder search hit can link to both the file
-- AND the specific commit its current summary is anchored to (see
-- webApp.ts's new per-commit view). FTS5 virtual tables don't support
-- ALTER TABLE ADD COLUMN the way a normal table does, so this
-- recreates it -- safe: ladder_index is a regenerable index (every
-- repo's next ladder_write_rung repopulates its own rows), never a
-- source of truth, so losing existing rows here is cosmetic, not data
-- loss.
DROP TABLE IF EXISTS ladder_index;
CREATE VIRTUAL TABLE ladder_index USING fts5(
  artifacts_name UNINDEXED,
  path UNINDEXED,
  kind UNINDEXED,
  commit_sha UNINDEXED,
  summary
);
