---
layout: docs
title: "Design sketch: cost tracking on the Ladder"
description: "A per-commit cost record -- tokens for agent work, hours for human work -- so walking the Ladder can answer 'what did this feature actually cost,' in both units at once, without collapsing the ones that genuinely have no reportable cost into a false zero."
---
# Design sketch: cost tracking on the Ladder

**Status: sketched, explicitly a future concern, not scheduled.** Captured now so the idea exists somewhere citable; the user's own framing was "I'm just anticipating that as a future concern," not a request to build it.

## The idea

Record a cost alongside whatever already gets recorded for a commit or changeset -- not a new ledger, an extension of the existing Ladder rung pattern (same git-notes-ref shape as `changeset`/`code`/`insights`). Walking a Lane's Ladder then answers a real question: what did this feature actually cost to build. In the human-contractor world that's hours; in the agentic world it's tokens. Both are real, neither should be forced into the other's unit.

## Two units, never collapsed into one number

- **Agent work**: tokens, straightforwardly measurable from the model call(s) that produced the commit.
- **Human work**: hours, tracked as `zz work` session *activity spans* -- actual engaged time, not raw wall-clock duration a session happened to stay open (someone stepping away for lunch shouldn't inflate the number). Also providable manually, either as part of `submit` (self-reported at commit time) or added afterward directly on the Ladder (retroactive annotation), since not every human workflow will run through an instrumented session.
- **Neither is required.** A plain human commit, made with no `--assist` and no session instrumentation, has a cost that's genuinely *not applicable* -- not zero. The record needs to distinguish "zero cost" from "no cost recorded," or every rollup silently understates real investment by treating untracked labor as free. Concretely, something like `{ tokens: number | null, hours: number | null }`, and any aggregation reports both halves separately: "$X of measured compute, plus Y hours of logged human time, plus N commits with no cost recorded" -- never collapsed into one misleading figure.

## Why this is worth having, beyond bookkeeping

Aggregating this up a Lane's own origin chain gives a real, defensible number: what a given feature, or a whole repo, actually represents in invested effort. That's not just an engineering curiosity -- it's a genuinely useful figure to have in hand when talking to anyone evaluating the project from outside it, the same way a contractor's logged hours are evidence of real investment to a client.

## What's still open

- How `zz work` actually instruments an "activity span" distinct from wall-clock session time -- not specified here.
- Whether cost should live as its own Ladder rung or as a field on the existing `changeset` rung -- the simpler of the two, probably the latter, not decided.
- Whether/how this interacts with the already-sketched budget model (a `zz work` session capping its own spend) -- likely independent; a session's self-imposed budget caps what it *will* spend, this records what a commit *did* cost, two different numbers that happen to be related.

## Tracked as

- [#45](https://github.com/zzmq-dev/zz/issues/45) Cost tracking on the Ladder -- explore later, not scheduled.
