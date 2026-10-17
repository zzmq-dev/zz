---
layout: docs
title: "Case study: designing on principle"
description: "Writing five principles down didn't invent new values -- it made existing ones checkable. What checking them against everything already designed turned up, and why the checkpoint has to be a recurring practice, not a one-time cleanup."
---
# Case study: designing on principle

**Status: framing written now; findings and fixes land here as the audit completes.**

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

*Pending -- the audit (reading every design doc's built-and-planned state, plus a spot-check of the codebase itself) is in progress. This section becomes a ranked list of findings, each with which principle it bears on, its severity, and exactly where it lives.*

## The fix, and what it cost

*Pending.* Expect at least one entry here to land as "left explicitly open" rather than "fixed" -- some findings will be genuine tradeoffs that still don't fully satisfy a principle, where the honest move is naming the gap rather than forcing a resolution that doesn't really hold. That's not a weaker outcome than fixing it; it's the same honesty [did:zz](/docs/did-zz/#whats-still-open) and the vouch graph already practice elsewhere in these docs.

## This has to be a recurring practice, not a one-time cleanup

The actual lesson, independent of whatever the audit finds: satisfying the five once doesn't keep them satisfied. Every design doc written after this one, every feature added, gets written without being checked against this list unless someone deliberately does the checking -- the same way a test suite doesn't stay green forever just because it passed once; it has to run again on every change for that to mean anything.

The commitment going forward, not just for this one pass: a new design doc gets checked against [Principles](/docs/principles/) before it's published, not sometime after, and the whole set gets re-audited on a real cadence independent of any single feature prompting it -- the same kind of standing discipline [Policy](/docs/governance/) already asks repos to adopt for themselves, applied here to the project's own design process.

## Tracked as

- [#25](https://github.com/zzmq-dev/zz/issues/25) Principles checkpoint audit: findings and fixes, plus making the re-audit a recurring practice.
