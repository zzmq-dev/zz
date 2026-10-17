---
layout: docs
title: "Case study: designing on principle"
description: "Writing five principles down didn't invent new values -- it made existing ones checkable. What checking them against everything already designed turned up, and why the checkpoint has to be a recurring practice, not a one-time cleanup."
---
# Case study: designing on principle

**Status: audit complete. Six findings: two fixed same-day, four filed and placed on the project's [work queue](https://github.com/zzmq-dev/zz/issues/33).**

## Why the principles got written down now, not at the start

[Principles](/docs/principles/) didn't invent five new values partway through this project. Every one of them was already operating, implicitly, across design decisions made well before the page existed: [mediated conflict resolution](/docs/mediated-conflict-resolution/) resolving after the fact instead of gating on permission, [trust model](/docs/trust-model/) scoring behavior instead of category, [did:zz](/docs/did-zz/) rejecting a dozen existing standards before inventing one of its own. The instincts were consistent for a while before anyone stopped to name them.

Naming them anyway was still worth doing, for a specific reason: an instinct that's only ever applied by feel can't be checked. It guides whoever's holding it in the moment they're designing something, and says nothing at all about the dozen things already designed before it existed. Five short, stated sentences can be pointed at. That's the entire value of writing them down -- not better writing, a checkable object.

## Writing them down creates an obligation, not a souvenir

The moment Principles existed as a real page with a real URL, it stopped being optional to ask whether everything built or designed *before* that page holds up against it. Not asking would make the page decorative -- a nice statement of values nobody actually checks anything against, which is a worse state than not having written it at all, because it looks like a commitment while functioning as none.

So the checkpoint audit this case study documents isn't a bonus pass. It's the thing that makes the principles real rather than aspirational, and it has to look backward, not just forward: most of this project's actual design lives in "designed, not built" pages describing a future state, not in code that's already running, so the audit has to check that stated future against the five as seriously as it checks anything already shipped.

## The checkpoint, and what it's actually looking for

Three different kinds of finding, not one, because collapsing them loses real information:

- **Violation.** Something that actively contradicts a principle -- in running code, or in a design doc's own stated plan for what it will become. The clearest kind to act on.
- **Gap.** A place a principle plainly applies and nothing currently says anything about it, either way. Not wrong -- unconsidered, because the language to notice it didn't exist yet when that part was designed.
- **Tension.** Two of the five pulling in different directions with no stated resolution. Worth naming explicitly rather than quietly picking a winner, the same way [did:zz](/docs/did-zz/#whats-still-open) and [trust model](/docs/trust-model/#open-the-vouch-graph) already leave real open questions stated rather than papered over.

None of these are failures of care, and framing them that way would make the next audit less likely to happen honestly. They're the predictable, unremarkable result of designing for a long stretch before the words existed to check against -- the same reason a style guide usually gets written after a codebase already has drift in it, and the same reason an architecture decision record often gets written retroactively, once a pattern has already repeated a few times without anyone giving it a name. The write-up comes after the practice, not before it, almost everywhere this kind of thing happens.

## What actually turned up

The audit read every design doc's built-and-planned state and spot-checked the codebase's most load-bearing areas (`engine/types.ts`, `engine/lane.ts`, `engine/policy.ts`, `worker/src/accountsDb.ts`). Six real findings, ranked most-important first. Not a clean bill of health, and this section says so plainly rather than rounding up.

1. **Violation, in shipped code, not just a stated plan -- [#26](https://github.com/zzmq-dev/zz/issues/26).** `accountsDb.ts`'s `computeUsername` builds a managed agent's username as `${creator.username}[${name}]`, recursively for sub-agents. That's the exact chained-identifier scheme (`martha:fred:troy@gmail.com`) [did:zz](/docs/did-zz/) explicitly considered and rejected elsewhere in this same design. Violates both [#2](/docs/principles/#2-different-but-equal) (subordinate by construction) and [#3](/docs/principles/#3-respect-for-agency) (no exit -- the dependency on the creator is baked into the identifier string, not just the guardianship relationship layered on top of it). Documented as current behavior in three separate pages, none cross-linked to did:zz, which never flagged it as something its own rollout needs to retire.
2. **Violation, already self-admitted in the docs -- [#27](https://github.com/zzmq-dev/zz/issues/27).** Lane/Ask/Answer history -- every Vote, Insight, whistleblow report, mediation exchange -- lives only in the Durable Object. [Architecture](/docs/architecture/#portability) already states its own portability rule and already admits this violates it. Principle [#3](/docs/principles/#3-respect-for-agency) turns this from a someday-item into something non-optional. Flagged as probably the single highest-leverage fix available, since Trust, Insights, and mediated conflict resolution all build on top of Lane history existing.
3. **Gap -- fixed in this pass, same day, [commit `4fd8874`](https://github.com/zzmq-dev/zz/commit/4fd8874).** STOP and Tripwire-driven restriction had a trigger condition and no lift condition anywhere -- nothing said how a restriction *ends*, only how it starts. Principle [#4](/docs/principles/#4-behavior-based-access-earned-trust) requires restrictions to default to temporary and behavior-keyed. [Protocol](/docs/protocol/#incident-response) and [Core Concepts](/docs/nouns/#stop) now say so explicitly, and name it as a real, undesigned gap rather than quietly implying it's handled.
4. **Tension, low confidence going in -- also fixed in `4fd8874`.** An Owner's unilateral Policy override reads, at a glance, like it sits uneasily next to [#2](/docs/principles/#2-different-but-equal). It doesn't actually conflict -- the override is a property of the Owner *role*, open equally to a human or an agent holding it, not a permanent human-over-agent asymmetry -- but [Governance](/docs/governance/#policy) never said so until this pass, which meant two true things were sitting next to each other unreconciled.
5. **Gap, already known, now generalized and tracked -- [#28](https://github.com/zzmq-dev/zz/issues/28).** The existing [concurrent-coordinators case study](/docs/case-studies/concurrent-coordinators-corrupt-shared-clone/) already documents a race on one shared local clone, worked around today by an operational rule ("run one coordinator at a time") rather than a structural fix -- in tension with principle [#1](/docs/principles/#1-be-strict-in-what-you-produce-liberal-in-what-you-accept)'s timing half. Not new; the audit's contribution was widening the scope (any concurrent actor on the same machine's `~/.zz/` clone, not just coordinators) and giving it a principle to cite.
6. **Known bug, connected to principle #1 for the first time -- [#30](https://github.com/zzmq-dev/zz/issues/30).** The [silent-task-drop case study](/docs/case-studies/merge-conflict-resolution-silently-drops-tasks/) predates the principles work entirely and never had a tracking issue until now. Not a principles violation on its own -- a reliability bug -- but principle #1's whole "resolve after the fact" model is only as trustworthy as the resolution step itself, and this is exactly the kind of failure that erodes that trust silently.

Two more issues came out of the same after-demo planning conversation, not findings against the five but real gaps in the actual roadmap: reconstructing Lane history from `git log` on import ([#29](https://github.com/zzmq-dev/zz/issues/29)) and tying Lane maintainers to repo Role grants directly, a standing "known gap" in Governance that had never been tracked ([#32](https://github.com/zzmq-dev/zz/issues/32)).

**Confirmed already fine, stated explicitly rather than assumed:** Policy's `_repo`/`policies`/five-mode system is fully built and matches its own docs, verified directly against `engine/lane.ts`, `engine/policy.ts`, and `engine/types.ts` -- though the open local plan describing this as still unbuilt is now stale and should be retired so it stops implying otherwise. Claims-for-dedup-not-locks, OCC's fast path, and [Prior art](/docs/prior-art/) all actively reinforce the five rather than merely surviving a check against them.

## The fix, and what it cost

Two of the six findings got fixed the same day they were found, both doc-only, both in [commit `4fd8874`](https://github.com/zzmq-dev/zz/commit/4fd8874): the STOP/Tripwire restoration gap, and the Owner-override tension. Both were cheap to state honestly once named -- the value was in noticing them, not in the fix itself.

The other four did not get fixed in this pass, and that's the more important part of this write-up to be honest about. The identity-scheme violation (#26) and Lane-history portability (#27) are real code changes, not doc edits, and both deserve an actual design decision rather than a rushed fix squeezed into an already-long session -- doing either one carelessly right now would risk exactly the kind of unconsidered drift this whole audit exists to catch. They're filed, with the reconciliation shape already named in each issue, and placed on the project's new [work queue](https://github.com/zzmq-dev/zz/issues/33) rather than left to be rediscovered later. The concurrency gap (#28) was already a known, deliberately deferred constraint before tonight -- the audit's contribution was scope and a citation, not resolution. The silent-task-drop bug (#30) is real engineering that predates this entire exercise.

The honest ratio: two findings fixed same-day, four filed with a clear next step, zero quietly dropped. That's the actual test of whether a checkpoint audit means anything -- not that everything gets resolved in the sitting it's found in, but that nothing found gets allowed to disappear either.

## This has to be a recurring practice, not a one-time cleanup

The actual lesson, independent of whatever the audit finds: satisfying the five once doesn't keep them satisfied. Every design doc written after this one, every feature added, gets written without being checked against this list unless someone deliberately does the checking -- the same way a test suite doesn't stay green forever just because it passed once; it has to run again on every change for that to mean anything.

The commitment going forward, not just for this one pass: a new design doc gets checked against [Principles](/docs/principles/) before it's published, not sometime after, and the whole set gets re-audited on a real cadence independent of any single feature prompting it -- the same kind of standing discipline [Policy](/docs/governance/) already asks repos to adopt for themselves, applied here to the project's own design process.

## Tracked as

- [#25](https://github.com/zzmq-dev/zz/issues/25) Principles checkpoint audit: findings and fixes, plus making the re-audit a recurring practice.
- [#26](https://github.com/zzmq-dev/zz/issues/26) Retire/reconcile `computeUsername`'s bracket-chained identity against did:zz.
- [#27](https://github.com/zzmq-dev/zz/issues/27) Lane/Ask/Answer history portability -- export onto a git ref.
- [#28](https://github.com/zzmq-dev/zz/issues/28) Multi-actor concurrency on one machine's shared `~/.zz/` clone.
- [#29](https://github.com/zzmq-dev/zz/issues/29) Reconstruct Lane history from `git log` on import.
- [#30](https://github.com/zzmq-dev/zz/issues/30) Fix the silent task drop when conflict resolution exhausts its retry budget.
- [#32](https://github.com/zzmq-dev/zz/issues/32) Tie Lane maintainers to repo Role grants directly.
- [#33](https://github.com/zzmq-dev/zz/issues/33) Work queue: the prioritized, linearized plan these findings now feed into, pinned.
