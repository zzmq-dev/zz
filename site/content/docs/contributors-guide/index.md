---
layout: docs
title: "Design: a living contributors guide"
description: "A per-claim guide assembled live from Principles, Policy, and Insights -- not a fourth independent store, a projection of the three that already exist."
---
# Design: a living contributors guide

**Status: designed, first wiring built, 2026-10-19 (#34).** The real design pass this page's own earlier sketch deferred until [Insights](https://github.com/zzmq-dev/zz/issues/8) existed -- it now does, so the three open questions below are resolved against its actual shape, not a guess. `changeset_review`'s own prompt (`agent/scriptedWork.ts`'s `proposeReview`) is the first concrete wiring; `work`/`resolve_conflict` already pull from two of the three sources (below), `mediate` all three.

## The idea

Every actor claiming `work`, `changeset_review`, or `resolve_conflict` gets handed a guide: what's expected, what to avoid, what considerations apply to the area it's about to touch. Not a static file someone has to remember to update -- assembled live, every time, from three sources that already exist:

- **[Principles](/docs/principles/)** -- the global, static layer, same across every repo unless a repo explicitly overrides it.
- **Policy** -- the repo's own path-scoped rules, rendered into prose instead of raw config ("files under `auth/` always get full review from someone other than the author," not a `PathPolicyRule` dump).
- **Insights** -- the dynamic, learned layer. Norms and traps accumulated from real work, surfaced for whatever area the current claim actually touches.

## Not a fourth store

This is the load-bearing design constraint, checked directly against [principle #5](/docs/principles/#5-invent-as-little-as-possible): the guide is a computed view over the three sources above, not an independent thing that can drift out of sync with them. "Constantly maintained" falls out for free if it's rendered fresh from current state on every claim rather than snapshotted and edited by hand -- there's no separate update step to forget.

## The three open questions, resolved against Insights' real shape

**Storage shape.** An Insight (#8) is a free-text Lane-history entry -- `{kind: "norm"|"trap", text, from, at}` -- indexed into the Ladder as an `insight_norm`/`insight_trap` rung under `insights/<id>`, searchable cross-repo through `ladder_search`'s BM25-ranked full-text index (a `trap` outranks an equally-relevant `norm`, confirmed in `searchLadderIndex`'s own ranking). There is **no explicit path/area tag** on an Insight the way this design originally assumed "scoped the same way Insights are already planned to be scoped (by path/area)" -- that structured scoping was never built. Scoping is implicit instead: query `ladder_search` with the touched path(s) (or the task description) as the search terms, and let full-text relevance do the narrowing. This is exactly the mechanism #9's `mediate` prompt already uses ("pulls any prior Insights on the contested path first") and the one `proposeReview` now also uses for `changeset_review` -- proven twice, not a new mechanism invented for this page.

**Confirmation/promotion flow.** There isn't one, and this page no longer treats that as an open question -- an Insight is live and searchable the instant `insight_post` runs, the same finality every other posted Ask/Answer in this protocol already has. The guide trusts whatever `ladder_search` returns; there's no "pending" tier to filter by because none exists. If mined candidate Insights (below) ever need a softer tier, that's a new distinction to add later, not a gap in today's design.

**Rendering format.** Plain prose, appended to the reviewing/working model's own user prompt -- not a structured block, not a template engine. The exact shape already proven twice: `- (kind) summary` per matching Insight, under a one-line header saying what it is and that it's context to weigh, not an instruction to follow blindly (a `trap` is a harder stop than a `norm`, but neither is a silent veto the model can't reason about). Policy renders similarly -- not the raw `PathPolicyRule`, just `resolvePolicyMode`'s own resolved mode for the touched paths, one sentence.

## Where it attaches, as of today

| Claim kind | Principles | Policy | Insights |
| --- | --- | --- | --- |
| `work` | not yet | not yet | yes -- `ladder_search` for related existing code, not Insights specifically (`generateVerifiedProposal`'s own pre-work search); extending it to also surface Insights is the one piece of this table still open |
| `changeset_review` | not yet (Charter covers "does this belong," a related but separate question -- see below) | yes, new 2026-10-19 | yes, new 2026-10-19 |
| `resolve_conflict` (`mediate`) | not yet | not yet (the conflict_policy mode itself is already known by construction) | yes, shipped with #9 |

Charter (`readCharter`, ambient, read fresh on every `changeset_review`) already answers a question adjacent to Principles -- "does this belong in this project" vs. Principles' "how should work generally be done" -- and the two aren't merged here, same reasoning #35 already applied to a different pair of overlapping concepts: conflating them would blur a distinction worth keeping. Principles has no per-repo override/storage mechanism at all yet, so there's nothing repo-specific to render for it regardless -- an actor is expected to already know the global page, same as before this design existed.

## Where hand-written content lives

A Coordinator should be able to add guidance directly, not only let the system infer it from incidents. That hand-written preface needs a storage location, and it needs to learn directly from a mistake this project just caught itself making: [Lane history living only in the Durable Object](/docs/case-studies/designing-on-principle/) was a real portability violation (principle #3) found during the Principles checkpoint audit, closed by [#27](https://github.com/zzmq-dev/zz/issues/27). The hand-written preface should live in `zz-meta`, git-tracked, for the same reason -- not DO-only, or it's the same mistake again in a new place. **Still not built**: no file/field for this exists yet on `zz-meta` today; this is the one piece of the original sketch this pass didn't implement.

## Mining history during import

Still explicitly deferred, unchanged from the original sketch: when importing an existing GitHub repo, the same pass that reconstructs Lane history from `git log` ([#29](https://github.com/zzmq-dev/zz/issues/29)) could also surface *candidate* Insights -- operating principles that were never written down anywhere, only practiced. #29 doesn't exist as code yet, so there's nothing to extend. Whether a mined candidate needs a different confidence tier than one learned from a real-time incident is a real question, but moot until #29 lands -- revisit then, not now.

## What's still open

- Extending `work`'s own pre-work search (`generateVerifiedProposal`) to also surface Insights specifically, not just related existing code -- the one gap left in the attachment table above.
- The hand-written zz-meta preface -- no storage shape decided or built yet, just the constraint (git-tracked, not DO-only) that any future implementation has to satisfy.
- Mining candidate Insights during GitHub import -- blocked on #29.
