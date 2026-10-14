-- A repo built via `zz ladder build`+`zz ladder push` (or, later, an
-- incremental sync run) spends real time -- minutes, not seconds --
-- between "the repo row exists" and "the Ladder/history is actually
-- complete". Default 'ready': every existing repo, and every repo
-- created the normal way (no import in progress), is ready the
-- instant it's created, same as before this column existed.
ALTER TABLE repos ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'ready' CHECK (ingest_status IN ('ready', 'ingesting'));
