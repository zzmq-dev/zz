---
layout: docs
title: "Ladder design"
description: "A working doc tracking the Ladder design as it gets built. Not yet reconciled with the rest of the docs."
---
# Ladder design

> **Archived.** This is a design or planning document from earlier in the project. It records the reasoning at the time it was written and may describe plans that changed or were never built. See the [Archive](/docs/archive/) index for context, or the [Overview](/docs/overview/) for how `zz` works today.

This tracks the Ladder's design while it's actively being built, the same way [Competition plan](/docs/competition-plan/) tracks the build. [Lanes and Ladders](/docs/lanes-and-ladders/) and [Data format](/docs/data-format/) stay as they are for now; nothing here is final, and this page is allowed to be wrong or change daily while implementation is in progress. Once the implementation settles, the relevant parts move into those pages and this one goes away or gets trimmed back to a pointer.

## What a Ladder is

A Ladder is its own structure, bigger than and separate from any one Lane. Its backbone is the repo's own file and directory tree, the thing every other kind of rung pivots on: a root rung summarizing the whole repo semantically, then a rung per directory, per file, per function, per line, each one explaining that piece of code. Anything that relates to a specific file or line attaches there, as a source on that rung.

Some artifacts aren't shaped like files. A release, or the package itself, hangs directly off the repo rung instead of nesting in the directory tree.

There's no separate "issue" concept, in zz or in the Ladder. A GitHub issue being filed is someone `ASK`ing the Maintainer about something, and a reply is either an `ANSWER` that resolves it or another `ASK` raising something new in the same thread, exactly the vocabulary native zz activity already uses. Onboarding doesn't get its own shape; it's the same protocol, read from a different source. An Ask rung is thread-shaped rather than containment-shaped: whatever follows it is a child rung, in order, the same way a line nests under a function, shaped differently. Only the *first* Ask in a thread is a repo-wide anchor; a reply that's itself Ask-shaped (someone raising a new problem partway through a conversation) stays embedded in that same thread rather than becoming its own top-level item, since it's still part of that one conversation. An Ask that relates to specific files doesn't contain them; it carries a reference to those files' rungs (without owning them), while the file's own rung cites it back as a source.

This is also where the native, forward-looking half of this lives, not just onboarding: any Agent, including a bare Reader with no write access, can `ASK` a Maintainer about a feature or a bug without any Lane existing yet to hold it. Those Asks accumulate on the Ladder the same way, and a Maintainer deciding what to work on reads its own backlog of them, checking against Policy (a new section, something like "don't start a feature until at least three people have asked for it") and watching for the same bug surfacing in multiple independent Asks as a prioritization signal. That's a different mechanism from a Tripwire, which is about safety escalation, not backlog priority, and it sits one step before [Lanes and Ladders](/docs/lanes-and-ladders/)' existing "a roadmap is the backlog" line, which is about proposed Lanes; an Ask is the raw demand signal that may or may not ever graduate into one. Not implemented yet, just confirmed in conversation; the two onboarded threads below are the only Asks that exist so far.

A Ladder also knows its dependencies, and lets a Maintainer reach across to a dependency's own Maintainer (and its Ladder) to ask about their specific local usage of it, at the same depth available locally.

## How it's built

**Onboarding, from GitHub**: derived directly from GitHub's own artifacts (commits, PRs, issues, comments, docs, code comments). No Lane is involved in this path, since historical GitHub activity never went through one.

**Ongoing, through zz**: once work flows through Lanes, Lane activity becomes the source the Ladder is built from, with precise links back to the Lane that produced each piece. A Lane builds its own local Ladder as it works, covering just what it touches, and merges that local Ladder into the repo's main one when it completes.

## Relationship to Lanes

A Ladder doesn't live inside a Lane. It's the much larger, code-shaped structure a Lane's own local Ladder eventually merges into. [Lanes and Ladders](/docs/lanes-and-ladders/)' current description of a rung ("the rungs represent the work decomposition tree") describes a Lane's local Ladder, not the main repo Ladder this page is about; reconciling that distinction into the main docs is part of what happens once this settles.

## Storage: git notes, not committed files

A rung is an annotation on a git object, not a standalone coordination record, so it lives in a git note attached to that object rather than a tracked file. [Data format](/docs/data-format/)'s existing argument against git notes ("most git hosts don't render them... a `.zz/` directory is just tracked files, visible on any host") still holds for Lanes, Roles, and Decisions, compact records a human should be able to browse on GitHub directly. It doesn't hold for the Ladder: a repo's worth of rungs is large, fully derived from source, and doesn't need file-browser visibility the way a coordination record does. Reconciling this distinction into `data-format.md` is part of what happens once this settles.

Concretely: a file's blob SHA, a directory's tree SHA, or the repo's root tree anchors a note holding that rung plus everything embedded under it (its functions, their line ranges) inline, so reading one file's whole local Ladder is one note read, not dozens.

Asks needed a different answer than "anchor to the commit that closed it": plenty never have one (duplicates, won't-fix, feature requests nobody built), so that commit often doesn't exist. They're repo-wide instead, anchored to the repo's root commit (its first commit, a fixed point that never changes), with the Ask's path folded directly into the note ref (`refs/notes/zz/ladder/asks/651`) rather than relying on the anchor object to tell them apart. That also sidesteps a failure mode found in testing: two unrelated rungs anchoring to the *same* commit (the commit that closes an issue is very often the one a release points at) silently clobbered each other under one shared note ref. Releases keep anchoring to their own commit, since a release reliably has one; a small file (`ladder-index.json`) tracks which commit each release note is attached to, since that can't be recomputed from a tree path the way a file's can. It's tiny and plain-committed, the same reasoning as keeping Lanes and Roles as files, and Asks no longer need it at all now that the ref itself carries their identity.

Getting the thread-vs-anchor split right took a bug fix: embedding a thread's children checked whether the *current* rung was already inside one, not whether its children were about to be, so a reply that was itself Ask-shaped (one level into a thread) was wrongly treated as its own top-level anchor and written as a dangling reference to a note that was never created. Fixed by computing "are this rung's children inside a thread" once, before deciding each child's fate, rather than reusing the parent's own flag.

Implemented via [isomorphic-git](https://isomorphic-git.org/), not by shelling out to the actual `git` binary or a native binding like `es-git`, for a reason that isn't speed: it's pure JS, so it's the only one of the three that can run in Cloudflare Workers, the target deployment. Workers has no `child_process` and no native addon loading, so shelling out and an N-API module both simply don't run there, no matter how fast they are locally. (`es-git`, native bindings to libgit2, is a better fit for local-only tooling later, like the TUI, where it isn't Workers-constrained.) One bug surfaced building this: commit refs stored for readability are short (`25122e6`), but git's notes tree indexes by full SHA, so a note written under a short SHA round-trips fine through isomorphic-git's own API but is invisible to the actual `git notes` CLI. Fixed by expanding every commit ref to its full SHA (`expandOid`) before using it as an anchor; the `git notes` CLI itself now lists every note this build writes, not just isomorphic-git's own read path.

## Repo-wide rungs beyond Asks

Two more kinds hang off the repo rung the same way Asks do (root-commit-anchored, identity folded into the ref, no separate index): `contributor`, one per person who's touched the repo, and `dependencies`, covering both directions, the repo's own runtime dependencies and an aggregate count of what depends on it. Neither threads the way Asks do; they're always top-level, never embedded.

Contributor rungs cite specific work where the file-level rungs already established it (five people so far: the founding author, the most active recent maintainer, whoever added http2, and so on); everyone else gets their GitHub contribution count and nothing invented beyond it. Dependencies cites the `package.json` entries; dependents cites GitHub's own aggregate numbers (dependency graph, not an enumerated list) rather than claiming to know who specifically depends on this repo.

## Status

Built a full Ladder for supertest, the smaller of the two demo repos. The file tree: all 5 source files (1202 lines) down to function and line-range rungs. Two threads researched in depth as Asks (`asks/798`, `asks/651`, the latter with a nested Ask where a reply raised a new regression rather than just answering), plus the `v6.3.1` release. Then a bulk pass added the remaining scale on top, deliberately lighter-weight: all 618 other issues and all 290 PRs as Asks (title, author, dates, outcome, explicitly marked as not researched in depth), all 46 other releases, all 92 contributors, and the dependencies/dependents rungs above. 1085 rungs total, from about 1060 git notes, every one of them readable by the actual `git notes` CLI, not just by this codebase's own read path. superagent (the larger repo) hasn't been attempted yet.

Two bugs surfaced doing the bulk pass at this scale, beyond the two already recorded above: both demo repos had transferred GitHub orgs since this was first written (both now canonically under `forwardemail`, not `ladjs`/`visionmedia`), caught because a release's own body text referenced the new org; and a bot contributor's login (`dependabot[bot]`) contains characters a git ref can't, fixed by sanitizing any repo-wide path before it becomes part of a ref rather than assuming a login is always ref-safe.

## Open questions

- Function- and line-level granularity: how deep is useful before it's just noise nobody reads?
- The two bulk-onboarded registers (908 lightweight Asks, 46 lightweight releases) are shallow by design. Deepening any of them to the level `asks/798`/`asks/651` got (comment threads, not just the opening post) is the same by-hand research, rerun for 908 more items, not done yet.
- The Maintainer's backlog-prioritization mechanism (Policy thresholds, clustering repeated Asks by topic) is confirmed in conversation but not built: no `policy.yaml` fields yet, no scanning logic, no grouping-by-topic. With 908 Asks now onboarded, there's finally enough data to test that clustering against.
- How the "ask a dependency's Maintainer" cross-repo query resolves when that dependency hasn't been onboarded into zz itself (which is the common case for anything outside this demo).
- Whether notes need to be pushed/fetched anywhere for a non-demo deployment, or whether they only ever need to exist on whichever Durable Object is computing them.
