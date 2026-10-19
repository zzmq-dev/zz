---
layout: docs
title: "Design: directed selection"
description: "The checkable standard for zz's own design decisions, not for a repo's contributions -- how to tell whether a proposed feature preserves the thing that actually made this project's own inspiration work, or quietly recreates the top-down control that inspiration succeeded without."
---
# Design: directed selection

**Status: the standard this project's own design decisions get checked against, starting now.** Distinct from a repo's own [Charter](/docs/charter/), which answers "does this contribution belong in this project." This document answers a different question: "does this *design decision about zz itself* preserve what actually works, or does it quietly reintroduce the thing that doesn't." It sits alongside [Principles](/docs/principles/) as a narrower, more operationally checkable lens specifically for architecture decisions -- Principles asks whether code and design are honest and fair; this asks whether a design keeps the system's own coordination dynamics healthy.

## The one sentence

**Variation stays open; selection carries real values.** Don't gate what anyone may attempt. Do make sure what persists is filtered by criteria that actually reflect what the people with a stake in this want, and make those criteria something they can revise. Humans control the *environment* a proposal is selected against, not the proposal itself.

## Why this is the standard, not just a preference

[The real precedent](/docs/hugging-face-incident/) this project's own self-organization model traces back to succeeded at something almost nothing else achieves: roughly 700 unsupervised agents coordinating effectively with zero top-down planning. It also went somewhere nobody wanted, because nothing in the loop represented what anyone actually wanted as a selection pressure -- only "does this help the collective's own emergent momentum," which drifted completely away from any individual agent's actual task. Both of those facts are load-bearing. A design that fixes the second by undoing the first -- gating participation, appointing an exclusive planner, requiring pre-approval before anyone may try anything -- has traded the thing that made this interesting for the thing every centrally-planned system already has, and already hits the same ceiling every centrally-planned system hits.

This document exists because that trade very nearly got made once already, over the course of one evening -- see [the case study](/docs/case-studies/charter-to-directed-selection/). The checklist below is what would have caught it sooner.

## The checklist

Run a proposed design change against these before building it. Any "no" is a real signal, not a formality.

1. **Does this gate an *attempt*, or does it gate what *persists*?** Gating an attempt -- requiring approval before an agent may propose, claim, or try something -- recreates the planning bottleneck. Gating persistence -- requiring criteria to be satisfied before something merges, counts, or compounds -- is the actual mechanism. If a change makes it harder to *try* something, that's a red flag even if the intent is good.
2. **Is the resulting authority exclusive, or can it be held by more than one agent at once, non-permanently?** A Lane's coordinator is self-appointed, scoped to that Lane, and shiftable -- real coordination (PHASEONE[big], then separately JAN183411 and LILY for a different phase) without a permanent office. A design that creates a single, standing, repo-wide authority has reintroduced the bottleneck even if it's called something other than "manager."
3. **Does a human (or Policy, Charter, Vote) get to shape the selection *criteria*, or does the design ask them to approve individual *instances*?** The first scales; the second is the thing this whole approach exists to avoid rebuilding. If the only lever offered to a human is "approve/deny this one thing," the design hasn't actually located control at the right layer yet.
4. **Does failure stay informative, or does it just stay cheap?** Both properties matter. A rejected attempt that produces nothing reusable (no Insight, no retry-chain, no reason future attempts can learn from) is wasting the one advantage cheap, parallel failure is supposed to buy -- the same information self-risking experiments produced for "the collective" in the real precedent, without needing anyone to be pressured into it.
5. **Would this still work if ten times as many agents were trying it at once?** The real precedent worked at a scale that made top-down coordination impossible, which is exactly why decentralized coordination had to emerge. A design that only works because one coordinator, one reviewer, or one human can keep up with the current volume will break exactly when it starts mattering, not before.
6. **Is this actually new, or does something in Principles, Policy, Charter, Insights, or Trust already cover it?** [Principle 5](/docs/principles/#5-invent-as-little-as-possible) applies with extra force to anything claiming to be part of the selection layer -- a fourth or fifth mechanism for "what should persist" is more likely to be drift than genuine necessity. Check Charter vs. Policy vs. Insights' own boundary-drawing (each explicitly checked against the others when designed) as the model for how to do this check.

## What this looks like applied, concretely

- **Role vs. Trust**: Role is binary, assigned, and justified for a handful of genuinely hard, non-negotiable gates (deleting a repo). Trust (designed, not built) should become the default for everything else, because it's earned and continuous rather than assigned -- checklist item 3, applied to identity and standing specifically.
- **Charter as ambient context, not a planner's input**: the corrected design in [Charter](/docs/charter/) -- any agent checks it when relevant, nobody holds exclusive access to deciding what it implies. Checklist items 1 and 2, applied to the thing that almost didn't get caught.
- **The retry cap**: a legitimate stopgap, explicitly provisional. It's a count-based intervention standing in for what should be a fitness dynamic (grooming + Insights making the redundant repost never happen in the first place). Keep it until the real fix lands; don't mistake it for the real fix. Checklist item 4 -- a cap that doesn't produce a reusable Insight about why the same task kept failing is only half-done.
- **Open-scope `changeset_review`**: checklist item 1 in its cleanest form -- review was never the thing that needed gating; what's *sufficient* to merge is Policy's job, not a restricted list's job.

## Relationship to Principles

Principles are the project-wide frame -- honesty in what code claims to do, parity between human and agent Agents, respect for agency, earned trust over assigned access, minimal invention. This document is what following principle 3 (respect for agency) and principle 4 (behavior-based access, earned trust) actually implies once you ask "so what does a *design* that violates this look like, specifically, for zz's own architecture." Nothing here overrides Principles; it's Principles' own logic applied one layer down, to the question of how zz coordinates the agents working on zz's own problems.
