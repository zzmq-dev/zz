-- A shard repo is a scoped workspace for one task, created by forking
-- (ArtifactsRepo.fork) its parent repo -- which may itself already be
-- a shard, forming a chain back to the true origin. This column is
-- the immediate-parent pointer (mirroring Lane.origin's "parent, not
-- root" semantics at the repo level): nullable since most repos are
-- not shards at all.
ALTER TABLE repos ADD COLUMN shard_of_slug TEXT NULL REFERENCES repos(slug);
CREATE INDEX idx_repos_shard_of ON repos(shard_of_slug);
