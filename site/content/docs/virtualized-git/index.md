---
layout: docs
title: "Design: virtualized git (future reference, not scheduled)"
description: "A reference for a possible later move away from git-as-source-of-truth -- materializing a repo on demand from a real database, a git sidecar with eventual consistency, or a full virtual git server backed by a distributed database instead of files on disk. Captured for later; no issue, no current plan to build it."
---
# Design: virtualized git

**Status: pure reference. Not scheduled, not an issue, not blocking anything else.** Captured now so the idea exists somewhere citable if it becomes necessary later, not because it's a near-term plan.

## The question this answers, if it's ever actually asked

[Lanes coordinate activity, Ladders coordinate state](/docs/lanes-and-ladders/) -- a repo is the backing store underneath both, plus a git-compatibility layer back to normal git tooling. That framing deliberately de-emphasizes git as *the* architecture and treats it as *an* implementation of the storage layer. If that storage layer ever becomes a real bottleneck -- at a scale or an access pattern actual git plumbing doesn't serve well -- the question worth having an answer ready for is: what replaces it without breaking the git-compatibility promise everything else depends on.

## Three shapes, roughly in order of how disruptive each one is

**Materialize a repo on demand.** The real database of record stops being git objects on disk; a git repo gets generated from that database when something actually needs to speak git (a clone, a fetch, a push negotiation), then discarded or cached. Git compatibility becomes a projection, the same relationship this project already uses for Policy, Insights, and now the [contributors guide](/docs/contributors-guide/) -- a view computed from a source of truth, not the source of truth itself.

**A git sidecar with eventual consistency.** Keep an actual git repo, but stop treating it as the single synchronous write path. Writes land in the real database first; a background process keeps a real git repo converging toward that state. A read that hits the git sidecar before it's caught up forces a resolve at access time rather than serving stale state silently -- the same "resolve after the fact rather than block up front" shape [principle #1](/docs/principles/#1-be-strict-in-what-you-produce-liberal-in-what-you-accept) already argues for elsewhere, applied to storage consistency instead of protocol timing.

**A full virtual git server.** The most disruptive shape: implement git's actual wire protocol (`upload-pack`, `receive-pack`, the smart HTTP protocol) against a backend that was never git objects at all -- a distributed database chosen for whatever access pattern actually matters (speed, query flexibility, horizontal scale), with git-shaped objects synthesized at the protocol boundary rather than stored natively anywhere. A real git client talking to it would never know the difference. This is the shape that most fully honors "git compatibility is a promise kept at the boundary, not an internal architecture commitment" -- and the most work by a wide margin.

## Why this isn't being built now

Nothing currently on the [work queue](https://github.com/zzmq-dev/zz/issues/33) depends on any of this. [Principle #5](/docs/principles/#5-invent-as-little-as-possible) applies directly: this would be a large, real invention, justified only once an actual access pattern or scale problem makes the current git-native storage a real constraint, not a theoretical one. Keeping this page around means that if that day comes, the option space is already sketched rather than re-derived from scratch under pressure.

## What would need to be true before this is worth picking up

- A concrete, observed bottleneck in git-native storage -- not a hypothetical one.
- Confidence the git-compatibility promise (anything can still `git clone`/`git push` against a zz repo with no special client) can be kept across whichever shape above gets chosen -- this is non-negotiable, not a tradeoff to weigh away.
- A real answer to how [Lane history portability](https://github.com/zzmq-dev/zz/issues/27) and the Ladder's git-notes storage map onto whichever backend replaces raw git objects, since both currently assume git-native storage directly.
