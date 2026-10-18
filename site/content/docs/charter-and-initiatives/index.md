---
layout: docs
title: "Design: Charter and Initiative Lanes"
description: "What a repo is for, stated explicitly instead of left tacit in a maintainer's head -- and the Lane-shaped convention for stating what it's actively pursuing right now, distinct from what it's willing to accept ever."
---
# Design: Charter and Initiative Lanes

**Status: designed, not built.**

## The gap, stated precisely

A mechanical gate -- tests pass, review approved, the right approval mode satisfied -- can only ever answer "was this done correctly." It cannot answer "should this exist here at all," because that question isn't about the diff, it's about the diff's relationship to a purpose the gate never looks at. A perfectly valid, well-tested image-editing web app is still wrong for a math library, regardless of how cleanly it was reviewed.

This isn't a gap specific to `zz`. Most real open-source projects never state this either -- the roadmap, the "why," the plan behind what gets built next, lives in one maintainer's head and never gets written down, because a single human doesn't need to externalize their own mental model to themselves. The gap is only visible here because `zz` is trying to formalize what coordination actually requires, and a multi-agent system doesn't have the thing that made the gap invisible before: there's no single mind holding tacit context across every task. Several contributor Agents working in parallel have nothing to share except what's actually written down. Make it explicit or it doesn't exist at all -- a human maintainer never faced that forcing function.

Found live, in this project's own bulk-ask demo: a `gcd` task whose changeset added a second, redundant `gcdB.js` nobody asked for. That submission was mechanically fine -- it would have passed review on code quality alone. It was wrong for a reason review had no vocabulary for: not "incomplete," not "needs changes," but "doesn't belong." Today's review has exactly one rejection shape. It needs at least three.

## Charter

A **Charter** is a per-repo document stating what the project is for: its purpose, its scope, and -- as important as the purpose itself -- its explicit non-goals. "Math utilities only; no UI, no I/O, no app-shell code" is a Charter sentence. A README gestures at this in passing; a Charter says it with enough precision that a reviewer (human or scripted) can actually check a changeset against it.

**Not Policy.** [Policy](/docs/governance/#policy) answers "was the right process followed" -- who approves, how many, under what mode. Charter answers a completely different question -- "should this exist here" -- that no approval mode can ever answer, because approval modes are checks on *process*, and belonging isn't a process question. A `vote_quorum`-approved image editor is still an image editor in a math library.

**Not Principles, not Insights either**, checked the same way the [living contributors guide](/docs/contributors-guide/) already checks itself against [principle #5](/docs/principles/#5-invent-as-little-as-possible) before assuming something needs a new store:
- [Principles](/docs/principles/) are global and static -- the same across every repo. A Charter is specific to *this* repo; it has no meaning shared across projects.
- Insights are learned, accumulated from real incidents over time. A Charter is declared, stated up front by whoever owns the project's direction -- not inferred from a pattern of past mistakes.

Since it fits none of the three existing sources, it's a genuine fourth one -- not a competing, independently-maintained store, but a fourth input to the same computed-view mechanism the contributors guide already uses. The guide becomes "assembled live from Principles, Policy, Insights, and Charter," still one non-duplicative projection, not a second drift-prone copy of anything.

**Governed by Policy's existing edit-gate pattern, without living inside Policy's content.** The Policy plan already has a `_repo`-scoped rule governing changes to Policy itself (Owner bypasses, a Maintainer is held to whatever the rule says). Editing the Charter reuses that exact mechanism -- its own rule, same shape, same bypass -- without the Charter's actual text ever being stored inside the `RepoPolicy` document. Policy governs the edit. It never holds the content.

## Initiative Lane

*(Named to avoid a real collision: [the root Lane](/docs/lanes-and-ladders/#the-root-lane) is already a specific, singular, formalized term -- the one per-repo Lane with id `_repo` that never completes. The concept below is not that. Reusing "root" for it would recreate exactly the kind of `_repo` overloading [already flagged and being cleaned up elsewhere](/docs/lanes-asks-and-roles/#renaming-_repo-to-origin-and-why-thats-three-fixes-not-one) in these docs.)*

Lanes already decompose: a Lane too large for one Changeset splits into child Lanes via `related_lanes`, each claimable and workable independently ([Lanes and Ladders](/docs/lanes-and-ladders/#decomposition)). A "project," in the roadmap sense, needs no new structural mechanism at all -- it's just a Lane at a coarser grain, with ordinary work-Lanes decomposed underneath it exactly the way any Lane already decomposes today.

What's actually missing is a convention, not a mechanism: a Lane at this level should be required to carry **explicit stated intent** -- why it exists, what it's trying to achieve right now, how it relates to the Charter -- where an ordinary Lane's origin today is just whatever Ask happened to spawn it, with no obligation to explain itself at that scale. A Lane carrying this -- call it an **Initiative Lane** -- is distinguished from an ordinary work-Lane only by that requirement and a marker Lanes can be queried by, nothing structural.

This gives review a third, more specific check, distinct from both of the others:

| Check | Question | Answered by |
| --- | --- | --- |
| Fitment to Ask | Did the changeset do what was requested? | Today's review, unchanged |
| Fitment to Charter | Is this the kind of thing this project does, ever? | Charter |
| Fitment to Initiative | Is this what we're actively pursuing *right now*? | The claiming Lane's nearest Initiative Lane ancestor |

The third row is genuinely distinct from the second, not a restatement of it: something can be perfectly Charter-compliant -- a math library can absolutely gain a new function -- and still be Initiative-misaligned, if the active Initiative is "harden numeric edge cases this cycle" and not "add more functions." Today's review has no way to make that distinction, because nothing states what "right now" even means for a given Lane.

## What this would have caught tonight

Contrasted deliberately against the Groq stream-truncation bug fixed earlier this session, because they're different failure categories and worth keeping apart:

- **The stream-truncation bug was mechanical.** A response got cut off mid-generation and was silently treated as complete -- a correctness bug with a correctness fix (detect the missing completion signal, throw instead of returning partial content). No judgment call was ever at stake.
- **The `gcd`/`median`/`isPrime` triage cases were not mechanical.** The submitted code was plausibly *valid* -- the review's own rejection reason ("incomplete") was simply the wrong category for what was actually wrong (unnecessary, in several cases; off-target, in others). No amount of retrying or backoff fixes a wrong rejection reason, because the problem was never a dropped connection -- it was a reviewer with no vocabulary for "this doesn't belong," only for "this isn't done yet."

Charter and Initiative Lane target exactly the second category. They don't replace the retry cap, the `needsTriage` flagging, or ask grooming's "is this already satisfied" check designed in [the Ladder-RAG doc](/docs/ladder-rag/#ask-grooming-a-third-use-of-the-same-retrieval-machinery-and-the-actual-fix-for-a-real-live-bug) -- they give review a vocabulary those mechanisms don't have, for a kind of wrongness none of them can detect on their own.

## Open questions

- Whether an Initiative Lane's stated intent should be free text, reviewed the same way a Charter edit is, or something more structured (closer to acceptance criteria) -- not yet decided.
- Whether a Lane without an Initiative Lane ancestor (today, that's everything) should be allowed to proceed unchecked against the Initiative row, or whether the absence itself should surface as a triage-worthy gap once this exists. Leaning toward the former for now -- this shouldn't become a second blocking gate on top of Charter before either has real-world mileage.
