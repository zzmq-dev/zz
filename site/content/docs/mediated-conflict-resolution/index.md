---
layout: docs
title: "Design: mediated conflict resolution"
description: "What happens when a resolve_conflict Ask can't be resolved automatically -- a hierarchical, policy-configurable mediation model, not a claim-before-work locking scheme."
---
# Design: mediated conflict resolution

**Status: designed, not built.** This page specifies a mechanism for the gap [Governance](/docs/governance/#mechanical-and-priority-conflicts) already names but doesn't yet fill: a **mechanical conflict** (overlapping edits) gets a three-way merge or a `resolve_conflict` Ask today, but when that Ask's own automatic attempt fails, there's no retry and no further process -- the task is silently dropped (see the [case study](/docs/case-studies/merge-conflict-resolution-silently-drops-tasks/)). Some of what reaches that point isn't really mechanical at all -- it's a **priority or design conflict** between two contributors who happened to submit at the same time, which the existing text already says "needs judgment." This page is what that judgment actually looks like, mechanized.

## What this isn't

The obvious-looking fix is to prevent the collision before it happens: have agents declare which files or symbols they're about to touch, lock those, and let a coordinator defer integration until every claim on a contested symbol resolves. A real, shipped project ([GitTub](https://gittub.hemanthhm.workers.dev/)) takes exactly this approach -- pre-commit "intent broadcasting," AST-level symbol locks declared before code generation.

This is the wrong direction, for three reasons:

1. **It doesn't match how independent, asynchronous contribution actually works.** Real open-source projects don't require checking in with a coordinator before starting; people work from their own local knowledge, submit when ready, and reconcile at the end if two submissions turn out to collide. Requiring a claim before every edit asks every contributor to maintain global awareness, which defeats the point of permissionless parallel work.
2. **It can't see the conflicts that actually matter most.** Two agents can declare entirely disjoint symbols -- one implements `gcd`, a different one implements `lcm`, which calls `gcd` -- and still be in real conflict if one changes a contract the other depends on. The conflict lives on a dependency edge, not on either declared target, so no claim granularity, however fine, catches it reliably without locking every transitive dependency of everything anyone touches.
3. **It only solves for code.** Concurrent edits to documentation, images, or any other artifact can conflict too, and symbol-level locking has nothing to say about them.

Claims in `zz` stay exactly what they already are: a way to prevent *duplicate* work on the same Ask, not a conflict-prevention mechanism. (A real bug surfaced during this design's own live testing -- two contributors granted a claim on the same Ask within 42ms of each other -- which is a correctness defect in that exclusivity check, tracked separately, and not something this design changes or depends on.)

## The model: resolve at the end, mediate hierarchically

Conflict handling stays entirely post-hoc. The granularity that matters is the Lane tree `zz` already has, not files or symbols:

- Claiming a `work` Ask already makes that claimant the new Lane's coordinator (`lane_propose`).
- [Decomposition](/docs/demos/decomposition/) already splits one Ask into sibling sub-Lanes under a parent, recorded in `related_lanes`.
- Every Lane already has its own `coordinators`/`maintainers`, independent of repo Role ([Local agent](/docs/demos/local-agent/)'s own correction covers this gap directly).

Extending this, rather than inventing something new: whoever holds a claim is the mediator of record for whatever it spawns beneath it. Doing the work directly means there's nothing to mediate at that level -- the one result just has to clear against siblings one level up. Decomposing means owning pairwise reconciliation among the resulting children before handing one settled result upward. The repo's own coordinator/maintainer is the same role at the root of the tree, with the real merge as its output instead of a result passed further up. A conflict between two unrelated top-level Asks with no common decomposition parent still has somewhere to be mediated -- the root, just later and wider in scope than a conflict caught early inside one decomposition.

This is media-agnostic by construction: the trigger is "do these two changesets conflict," which git already answers for any file type (three-way text merge, or an unmergeable binary diff) -- nothing here needs to parse code.

## Conflicts get a bounded window, not an instant verdict

A conflict shouldn't be resolved the instant it's detected (a third, not-yet-processed submission against the same base might change the right answer) or left open indefinitely (that just never resolves). The fix reuses a primitive that already exists: `expiry_hours`, already part of `PolicyRule` for `vote_expiring`'s own lazy-consensus deadline.

A detected conflict becomes its own Ask (the existing `resolve_conflict` kind) carrying a deadline. Any further submission against the same contested base that arrives before the deadline attaches to the same conflict instead of being ignored. Whatever resolution strategy applies only runs once the window closes, using everything that arrived by then. The cheapest modes below (`first_wins`, `coordinator_decides`) skip the window entirely -- they don't need to collect multiple perspectives, so there's nothing to wait for.

## `conflict_policy`: a second, orthogonal Policy axis

[Governance](/docs/governance/#policy)'s existing Policy document answers "what does it take to approve a clean change" (`direct` / `self_review` / `other_approver` / `vote_quorum` / `vote_expiring`). This is a different question -- "what happens when two changes collide" -- and a repo should be able to set it independently per path, same glob matching, same most-specific-wins resolution:

| Mode | What happens | Reuses |
| --- | --- | --- |
| `first_wins` | Whoever's changeset reaches the merge first wins; the other is denied and reposted as a fresh attempt against the new HEAD. No window. | Today's `resolve_conflict` deny-and-repost, made explicit rather than the only option. |
| `coordinator_decides` | The coordinator's own merge authority extends to picking the outcome unilaterally. No window, no further process. | Existing merge authority. |
| `vote` | A real Committee Vote on the conflict, same ballots and quorum rules as any other Vote. | The existing Committee/Vote machinery. |
| `escalate_human` | Blocks on a human decision. | The existing `--assist`/`zz review` human-in-the-loop path. |
| `mediate` | See below -- the one genuinely new mechanism. | — |

`discard_and_reclaim` -- release the original claim, let someone else pick it up fresh -- isn't a mode a repo selects on purpose. It's the universal outcome when whichever mode *was* selected fails to reach a decision by its window's deadline: a Vote ties or misses quorum, mediation can't find a resolution and no human is configured. Nothing is erased when this happens -- Lane history is never touched by anything else in this system, so the discarded attempts and exactly why they collided stay visible. Whoever claims the Ask next already runs a Ladder search before writing anything, so the record of what didn't work and why is the first thing they'd see, not information they have to rediscover by repeating the same collision.

## `mediate`: the actual mechanism

Grounded in established mediation practice (sources: [Getting to Yes principles](https://milesmediation.com/blog/how-principles-found-in-getting-to-yes-can-help-provide-better-mediation-outcomes-for-both-sides/), [mediation process stages](https://instruct.uwo.ca/law/454d/law_med/topic5.htm), [mediator technique](https://www.nar.realtor/sites/default/files/handouts-and-brochures/2013/mediation-key-communication-skills-overview.doc), [divorce mediation practice](https://sandiegofamilylawyer.net/successful-divorce-mediator-tips-a-mediators-approach-to-ensuring-every-voice-is-heard/)), adapted for two points where AI mediation genuinely differs from human mediation: confidentiality doesn't transfer (every exchange is ordinary, public Lane history -- an upgrade over private human mediation, not a loss), and self-determination is deliberately weakened (the mediator can have the final say, since asynchronous agents can't be brought into a live room the way the model's own human-mediation precedent assumes).

**Position versus interest.** A changeset's diff is a position -- what the change looks like. The underlying interest -- *why* it needs to look that way -- is what actually needs to be reconciled. The mediation payload carries both sides' task description and changeset, but getting real mileage out of this probably needs a small extraction step that states the interest explicitly, separate from the diff, the same way a human mediator reframes "I want X" into "why do you need X."

**Invent options for mutual gain, first.** The mediator's first move is to look for a third option that satisfies both interests -- which might mean a genuinely new function signature neither side proposed -- not to pick a winner. This is the formal name (from principled negotiation) for what was informally "synthesize A and B" earlier in this design's own development: not a literal merge of two diffs, which usually doesn't even typecheck for something like a signature dispute, but a reconciled design serving both.

**Objective criteria as the fallback.** When no mutual-gain option exists, fall back to something already-objective -- existing tests, the Ladder's own documented contract for the symbol, established convention elsewhere in the repo -- rather than straining to invent a synthesis that isn't really there.

**Neutral framing.** Whatever drives this (model prompt, or Jev's own `state`) critiques the changeset, never the agent -- "this doesn't handle negative inputs," never anything framed as one party having failed.

**Durable output.** Every mediation that reaches a real resolution, or fails to, writes an [Insight](#insights-the-durable-memory) documenting the now-clarified contract, so the next contributor who'd hit the same ambiguity finds it already resolved instead of colliding with it again.

### Without Jev: a single mediator call

The default path, no external dependency: one call to whatever model backend is already configured. It picks the first side, the second side, or synthesizes a third option satisfying both -- and self-reports which of the three happened. "I picked a side because no synthesis was possible" escalates the same way a low-confidence root would in the Jev path below, just on a weaker signal: a general-purpose generative model self-reporting here is less reliable than a model built specifically to be calibrated, since generative models are known to be overconfident about exactly this kind of judgment call. Worth being honest about that gap rather than treating both paths as equivalent.

### With Jev: triage, scoring, and a Kialo-shaped argument tree

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is TypeSafe's "System One" model -- fast (70-500ms), cheap, type-safe structured decisions (`Choice`, `Score`, `Noul` primitives, each returning calibrated probabilities and confidence, evaluated in parallel against a shared `state`). It is **not** a Mixture-of-Experts model -- neither the announcement nor the docs mention MoE anywhere, confirmed directly. What it actually is turns out to fit better anyway: a fast, reliable judge for small structured questions, not a reasoning/generation model, meant to be called repeatedly by other software.

Three uses, layered on top of the no-Jev path rather than replacing it:

1. **Triage before the expensive path runs.** Every detected conflict gets one `Choice` call: trivial (no real interest clash, safe to auto-merge), genuine interest conflict, or false positive. Cheap enough to run on every conflict, unlike the full mediation flow.
2. **Scoring a candidate reconciliation.** Once a generative model proposes a mutual-gain option, Jev `Score`s how well it satisfies each side's own extracted interest independently -- a calibrated check instead of trusting the mediator's self-assessment.
3. **Resolving an argument tree bottom-up**, shaped like [Kialo](https://en.wikipedia.org/wiki/Kialo)'s claim/Pro/Con structure -- though Kialo itself only maps and lets humans rate impact, it never auto-resolves to a conclusion, so this is a genuinely new mechanism built on Kialo's structural idea, not something Kialo does. Root is the contested question, branches are each side's interest-based argument, sub-branches are counter-considerations and objective evidence. Jev resolves one `Choice`/`Score` per node, working upward; the root's own confidence becomes the system's confidence in the whole resolution.

Jev's calibrated confidence is also the objective trigger for escalation -- low confidence at the root is a principled, consistent signal that a point is genuinely contested, routed to `vote` or `escalate_human`, rather than an arbitrary heuristic deciding that.

**Pluggable, not load-bearing.** Same posture as `--provider groq/gemini/ollama/cloudflare` for model choice: a repo without Jev configured gets the no-Jev fallback above, slower and less calibrated but fully functional. A new `request_decision(state, questions[])` tool wraps Jev the same way every other capability in this system is a named `ToolDef` dispatched through the repo's own Durable Object (`commit_changeset`, `ladder_write_rung`, …) -- no new infrastructure, and usable by any agent validating its own thinking, not just the mediator.

## Insights: the durable memory

An [Insight](/docs/nouns/#insight) (`norm`/`trap`-tagged, already a defined noun, not yet postable by any tool) is the concrete mechanism behind "every mediation outcome should make the next collision less likely." It lives on the Ladder, the same way everything else there does: the Ladder already splits its data across multiple git-notes refs by category (`refs/notes/zz/ladder/changeset`, `refs/notes/zz/ladder/code`, confirmed directly against a real repo) -- a third ref for Insights is the same pattern again, not a new mechanism, anchored with the same attach-to-an-existing-git-object mechanics the rest of the Ladder already uses.

Granularity follows the existing rung-kind conventions: repo-wide anchors to `_repo` (like a `repo`-kind rung), file-level anchors to the file's own path (like a `file`-kind rung), and anything narrower than a file nests under that file's own Insight as a child, the same way `function`-kind rungs already have no independent anchor of their own.

Consultation is close to free. Contributors already run `ladder_search` before writing anything -- a `trap`-kind Insight on a contested path surfaces through that existing step, maybe with a ranking boost over an ordinary summary, since ignoring a documented trap should cost more than missing a routine note. The mediator pulls any existing Insights on the contested path into its own context as a standard step before building its payload -- not a new retrieval path, the same `ladder_search`/`ladder_read` every contributor already uses.

## Open questions

- The claim-exclusivity race (two contributors granted the same Ask's claim near-simultaneously) is a real, separate bug, tracked on its own -- not fixed by anything in this design, and not something this design depends on.
- Pairwise mediation across more than two conflicting parties folds left (resolve the first pair, treat the result as one side, resolve against the next) rather than attempting a genuine N-way negotiation -- simpler to reason about, at the cost of being order-sensitive in a way a true N-way resolution wouldn't be.
- The exact shape of "interest extraction" (a distinct step, or folded into how a `work` Ask's description and a `submit_changeset`'s summary already get written) isn't settled yet.
