---
layout: docs
title: "Ladder design"
description: "A working doc tracking the real Ladder design as it gets built. Not yet reconciled with the rest of the docs."
---
# Ladder design

This tracks the Ladder's real design while it's actively being built, the same way [Competition plan](/competition-plan/) tracks the build. [Lanes and Ladders](/lanes-and-ladders/) and [Data format](/data-format/) stay as they are for now; nothing here is final, and this page is allowed to be wrong or change daily while implementation is in progress. Once the implementation settles, the relevant parts move into those pages and this one goes away or gets trimmed back to a pointer.

## What a Ladder is

A Ladder is its own structure, bigger than and separate from any one Lane. Its backbone is the repo's own file and directory tree, the thing every other kind of rung pivots on: a root rung summarizing the whole repo semantically, then a rung per directory, per file, per function, per line, each one explaining that piece of code. Anything that relates to a specific file or line attaches there, as a source on that rung.

Some real artifacts aren't shaped like files. A release, or the package itself, hangs directly off the repo rung instead of nesting in the directory tree. Issues and PRs are rungs too, but thread-shaped rather than containment-shaped: a comment is a child rung of its issue or PR, in order, nesting the same way a line nests under a function, shaped differently. An issue or PR that relates to specific files doesn't contain them; it carries a reference to those files' rungs (without owning them), while the file's own rung cites it back as a source.

A Ladder also knows its dependencies, and lets a Maintainer reach across to a dependency's own Maintainer (and its Ladder) to ask about their specific local usage of it, at the same depth available locally.

## How it's built

**Onboarding, from GitHub**: derived directly from GitHub's own artifacts (commits, PRs, issues, comments, docs, code comments). No Lane is involved in this path, since historical GitHub activity never went through one.

**Ongoing, through zz**: once work flows through Lanes, Lane activity becomes the source the Ladder is built from, with precise links back to the Lane that produced each piece. A Lane builds its own local Ladder as it works, covering just what it touches, and merges that local Ladder into the repo's main one when it completes.

## Relationship to Lanes

A Ladder doesn't live inside a Lane. It's the much larger, code-shaped structure a Lane's own local Ladder eventually merges into. [Lanes and Ladders](/lanes-and-ladders/)' current description of a rung ("the rungs represent the work decomposition tree") describes a Lane's local Ladder, not the main repo Ladder this page is about; reconciling that distinction into the main docs is part of what happens once this settles.

## Storage: git notes, not committed files

A rung is an annotation on a real git object, not a standalone coordination record, so it lives in a git note attached to that object rather than a tracked file. [Data format](/data-format/)'s existing argument against git notes ("most git hosts don't render them... a `.zz/` directory is just tracked files, visible on any host") still holds for Lanes, Roles, and Decisions, compact records a human should be able to browse on GitHub directly. It doesn't hold for the Ladder: a real repo's worth of rungs is large, fully derived from source, and doesn't need file-browser visibility the way a coordination record does. Reconciling this distinction into `data-format.md` is part of what happens once this settles.

Concretely: a file's blob SHA, a directory's tree SHA, or the repo's root tree anchors a note holding that rung plus everything embedded under it (its functions, their line ranges) inline, so reading one file's whole local Ladder is one note read, not dozens. Issues, PRs, and releases anchor to the real commit already associated with them, since there's no tree path for an issue. That introduces a real failure mode: two unrelated rungs anchoring to the *same* commit (the commit that closes an issue is very often the one a release points at) would silently clobber each other under one shared note ref, which is exactly what happened in testing. The fix is a separate note ref per kind that anchors to a commit (`refs/notes/zz/ladder/issue`, `.../pr`, `.../release`), while file/directory/repo share one ref (`.../code`) since blob/tree SHAs are content-addressed and don't collide the same way in practice. A small file (`ladder-index.json`) still tracks the commit each issue/release note is actually attached to, since that can't be recomputed from a tree path the way a file's can; it's tiny and plain-committed, the same reasoning as keeping Lanes and Roles as files.

Implemented via [isomorphic-git](https://isomorphic-git.org/), not by shelling out to the real `git` binary or a native binding like `es-git`, for a reason that isn't speed: it's pure JS, so it's the only one of the three that can run in Cloudflare Workers, the actual target deployment. Workers has no `child_process` and no native addon loading, so shelling out and an N-API module both simply don't run there, no matter how fast they are locally. (`es-git`, native bindings to libgit2, is a better fit for local-only tooling later, like the TUI, where it isn't Workers-constrained.) One real bug surfaced building this: commit refs stored for readability are short (`25122e6`), but git's notes tree indexes by full SHA, so a note written under a short SHA round-trips fine through isomorphic-git's own API but is invisible to the real `git notes` CLI. Fixed by expanding every commit ref to its full SHA (`expandOid`) before using it as an anchor; the real `git notes` CLI now lists every note this build writes.

## Status

Built a full Ladder for supertest, the smaller of the two real demo repos: all 5 real source files (1202 lines) down to function and line-range rungs, plus two complete real issue threads (`#798`, `#651`) and the `v6.3.1` release, all stored as git notes in the real clone per the scheme above. superagent (the larger repo) hasn't been attempted yet.

## Open questions

- Function- and line-level granularity: how deep is useful before it's just noise nobody reads?
- PR/issue/comment ingestion at the scale of a real, active repo: GitHub API pagination and rate limits haven't been dealt with yet.
- How the "ask a dependency's Maintainer" cross-repo query resolves when that dependency hasn't been onboarded into zz itself (which is the common case for anything outside this demo).
- Whether notes need to be pushed/fetched anywhere for a real (non-demo) deployment, or whether they only ever need to exist on whichever Durable Object is computing them.
