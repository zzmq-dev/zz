---
layout: docs
title: "Case study: two coordinators racing on one local clone"
description: "Running a second coordinator-scope zz work process against the same repo corrupts the shared local clone mid-merge -- a real concurrency gap, not fixed yet."
---
# Case study: two coordinators racing on one local clone

Found live, 2026-10-15, while rehearsing the [Bulk Asks](/docs/demos/bulk-asks/) demo stage -- a second `maint` process was started against the same repo to try to clear a review/merge backlog faster, and it immediately hit a confusing git error on an otherwise-healthy repo.

## Symptom

```
fatal: path 'test/median.test.js' exists on disk, but not in '<sha>'
```

Followed immediately by the new process answering an Ask that a *different* process had already completed moments earlier -- the two coordinators had both picked up the same queue and started stepping on each other.

## Root cause

A coordinator's merge step (`runCoordinatorSubmitChangeset`, `agent/scriptedWork.ts`) doesn't do its work in an isolated space. It runs plain `git` commands directly against one shared, persistent local clone under `~/.zz/repos/<slug>` -- the same directory on every invocation:

- `fileContentAtCommit` (`engine/ingest.ts`) runs `git -C <repoDir> show <sha>:<path>` to read a file's content at a specific commit, for the three-way merge.
- `syncClone` (`cli/lib/repo.ts`) runs `git -C <repoDir> reset --hard origin/main` before every claimed Ask, to catch up with whatever landed on the real remote since the last read.
- The merge step also fetches a task shard's objects straight into this same directory (`git -C <repoDir> fetch ... main`).

None of this is scoped per-invocation. Two coordinator processes against the same repo -- even under the exact same identity -- can have one process's `reset --hard` land on the shared working tree in the middle of the other's read, which is exactly what "path exists on disk, but not in `<sha>`" is: the working tree changed underneath an in-flight `git show`.

Contributors don't hit this, because they write in their own per-task shard directories (`mathkit[task-name]`, a separate clone each) -- only the coordinator's merge step touches the one shared, persistent `mathkit` directory directly.

## Why this matters for scaling past a demo

A single coordinator is a real throughput ceiling: review latency scales with the size of the file being reviewed (`changeset_review`'s payload embeds full file content, not a diff -- a separate finding this session), and merge itself is serial. With several contributors producing work faster than one coordinator can review and merge it, review/merge backs up even though nothing is actually broken. Running a second coordinator to parallelize that is the natural thing to try -- and it's exactly what corrupts the shared clone.

## Status

Not fixed -- deferred past this demo recording on purpose, to avoid destabilizing a run that was otherwise going well. The agreed fix: give each coordinator operation its own isolated `git worktree` (`git worktree add`/`remove`, the same pattern already used for contributor sandboxing in `run_in_sandbox`, `agent/tools.ts`) instead of one shared persistent directory. A worktree shares the same `.git` object store as every other worktree of the same repo, and that object store *is* safe for concurrent access -- only the shared working tree isn't. This generalizes cleanly to real multi-machine scaling too, since each coordinator just needs its own clone of the objects, not a lock on one shared directory.

**For now: run at most one coordinator (coordinator-scope `zz work`) per repo at a time.** Multiple contributors (`--scope contributor`) running concurrently against the same repo is unaffected by this and stays safe.
