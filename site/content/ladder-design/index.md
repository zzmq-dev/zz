---
layout: docs
title: "Ladder design"
description: "A working doc tracking the real Ladder design as it gets built. Not yet reconciled with the rest of the docs."
---
# Ladder design

This tracks the Ladder's real design while it's actively being built, the same way [Competition plan](/competition-plan/) tracks the build. [Lanes and Ladders](/lanes-and-ladders/) and [Data format](/data-format/) stay as they are for now; nothing here is final, and this page is allowed to be wrong or change daily while implementation is in progress. Once the implementation settles, the relevant parts move into those pages and this one goes away or gets trimmed back to a pointer.

## What a Ladder is

A Ladder is its own structure, bigger than and separate from any one Lane. It's shaped like the code, not like the work: a root rung summarizing the whole repo semantically, then a rung per directory, per file, per function, per line, each one explaining that piece of code.

At any rung, drilling down surfaces its full history, itself summarized at multiple levels: releases, PRs, changesets. That history draws on everything related to it: PR conversations, issues and their comments, docs, code comments, not just commit messages.

A Ladder also knows its dependencies, and lets a Maintainer reach across to a dependency's own Maintainer (and its Ladder) to ask about their specific local usage of it, at the same depth available locally.

## How it's built

**Onboarding, from GitHub**: derived directly from GitHub's own artifacts (commits, PRs, issues, comments, docs, code comments). No Lane is involved in this path, since historical GitHub activity never went through one.

**Ongoing, through zz**: once work flows through Lanes, Lane activity becomes the source the Ladder is built from, with precise links back to the Lane that produced each piece. A Lane builds its own local Ladder as it works, covering just what it touches, and merges that local Ladder into the repo's main one when it completes.

## Relationship to Lanes

A Ladder doesn't live inside a Lane. It's the much larger, code-shaped structure a Lane's own local Ladder eventually merges into. [Lanes and Ladders](/lanes-and-ladders/)' current description of a rung ("the rungs represent the work decomposition tree") describes a Lane's local Ladder, not the main repo Ladder this page is about; reconciling that distinction into the main docs is part of what happens once this settles.

## Status

Prototyping a representative slice (one real file, in one of the superagent/supertest repos) to get a sense of the real shape and effort before committing to building the entire repo's Ladder. The goal before the full demo is the entire repo built out; the slice is a sizing exercise.

## Open questions

- Function- and line-level granularity: how deep is useful before it's just noise nobody reads?
- PR/issue/comment ingestion at the scale of a real, active repo: GitHub API pagination and rate limits haven't been dealt with yet.
- How the "ask a dependency's Maintainer" cross-repo query resolves when that dependency hasn't been onboarded into zz itself (which is the common case for anything outside this demo).
