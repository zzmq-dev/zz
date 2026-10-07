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

## Status

Prototyped a representative slice against supertest: one real file (`index.js`) down to line-level rungs, plus one real release (`v6.3.1`) and one real issue (`#798`) with its actual two-comment thread, each `touches`-referencing the `package.json` file rung it relates to. Confirms the shape; the goal before the full demo is the entire repo built out, which this slice doesn't yet attempt.

## Open questions

- Function- and line-level granularity: how deep is useful before it's just noise nobody reads?
- PR/issue/comment ingestion at the scale of a real, active repo: GitHub API pagination and rate limits haven't been dealt with yet.
- How the "ask a dependency's Maintainer" cross-repo query resolves when that dependency hasn't been onboarded into zz itself (which is the common case for anything outside this demo).
