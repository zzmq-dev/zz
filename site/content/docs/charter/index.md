---
layout: docs
title: "Design: Charter"
description: "What a project is for and what it will never accept, stated with enough precision that a reviewer -- human or scripted -- can actually check a contribution against it. Plus the origin Lane's standing ask, the mechanism that keeps a Charter from just being one more document nobody consults."
---
# Design: Charter

**Status: designed, not built.**

## The gap, stated precisely

A mechanical gate -- tests pass, review approved, the right approval mode satisfied -- can only ever answer "was this done correctly." It cannot answer "should this exist here at all," because that question isn't about the diff, it's about the diff's relationship to a purpose the gate never looks at. A perfectly valid, well-tested image-editing web app is still wrong for a math library, regardless of how cleanly it was reviewed.

This isn't a gap specific to `zz`. Most real open-source projects never state this either -- the roadmap, the "why," the plan behind what gets built next, lives in one maintainer's head and never gets written down, because a single human doesn't need to externalize their own mental model to themselves. The gap is only visible here because `zz` is trying to formalize what coordination actually requires, and a multi-agent system doesn't have the thing that made the gap invisible before: there's no single mind holding tacit context across every task. Several contributor Agents working in parallel have nothing to share except what's actually written down. Make it explicit or it doesn't exist at all -- a human maintainer never faced that forcing function.

Found live, in this project's own bulk-ask demo: a `gcd` task whose changeset added a second, redundant `gcdB.js` nobody asked for. That submission was mechanically fine -- it would have passed review on code quality alone. It was wrong for a reason review had no vocabulary for: not "incomplete," not "needs changes," but "doesn't belong." Today's review has exactly one rejection shape. It needs at least two.

## What real projects call "charter," and why none of it is actionable

Checked directly against the two most common references for this, rather than assumed: a [UNICEF DPG guide on project charters](https://unicef.github.io/inventory/dpg-indicators/3/charters/) and [opensource.org's own piece on drafting one](https://opensource.org/blog/what-is-open-governance-drafting-a-charter-for-an-open-source-project). Both describe the same shape -- vision and mission statements, a community/roles section, a licensing stance, a code of conduct, and a governance structure (steering committee, voting rules, chair selection). That's a real and useful document. It is not a document any reviewer could check a diff against. "Vision: an ideal the project reaches for" doesn't tell you whether `gcdB.js` belongs.

Real projects confirm this at scale, not just in template guides. [Linkerd](https://github.com/linkerd/linkerd2) has `MAINTAINERS`, `STEERING`, `SECURITY`, `GOVERNANCE`, and `CODE_OF_CONDUCT` -- five separate documents, none of which say what should get built or what acceptance criteria a change needs to meet. [Kubernetes'](https://github.com/kubernetes/community/tree/main/contributors/guide) contributors guide is enormous and almost entirely about *process* -- it says almost nothing about what Kubernetes is actually trying to accomplish. The closest thing it has is ["why you need Kubernetes"](https://kubernetes.io/docs/concepts/overview/#why-you-need-kubernetes-and-what-can-it-do), and even that describes what already exists, looking backward, rather than stating a forward-looking standard a new contribution could be checked against.

The one element worth keeping from the standard template is **Scope** -- "what the project will and won't address." Everything else in a conventional charter (community roles, licensing, voting mechanics) is governance, and `zz` already has a place for that: [Policy](/docs/governance/#policy) and the Role/Committee model. A `zz` Charter is deliberately narrower than what the word usually means, and deliberately more operational than any of the above -- it keeps only Scope, and pushes it down to the level of an actual checkable standard rather than a paragraph of aspiration.

## Charter

A **Charter** is a per-repo document stating what the project is for and what it will never accept, specific enough that a reviewer (human or scripted) can check a changeset against it directly rather than exercise judgment from scratch every time.

A tidied version of a real example from tonight's conversation, for Mathkit:

```
Mathkit is a pure-JavaScript math library. It contains a variety of
top-level functions implementing a full-featured, dependency-free
math library. It should strive to cover as many kinds of mathematical
functions as it can, to serve any need for math operations.

Each function MUST be tested with a minimum of 5 unit tests, or as
many as there are branching pathways within the function, whichever
is greater -- covering both expected and unexpected inputs, and any
NaN or null cases that are possible, across a wide range of numeric
inputs.

Each function MUST be documented in the README.

Mathkit should ONLY include these three kinds of things: code in
src/, tests in test/, and docs in the README.
```

Every real triage incident from tonight is directly checkable against this: the `gcd`-duplicate and the `median`-touching-`index.js` cases both violate the last line outright; the "tests only, implementation already at HEAD" cases become correctly recognizable as *complete*, not incomplete, once a reviewer can check test count and location against an actual stated minimum instead of guessing.

**Not Policy.** [Policy](/docs/governance/#policy) answers "was the right process followed" -- who approves, how many, under what mode. Charter answers a completely different question -- "should this exist here" -- that no approval mode can ever answer, because approval modes are checks on *process*, and belonging isn't a process question. A `vote_quorum`-approved image editor is still an image editor in a math library.

**Not Principles, not Insights either**, checked the same way the [living contributors guide](/docs/contributors-guide/) already checks itself against [principle #5](/docs/principles/#5-invent-as-little-as-possible) before assuming something needs a new store:
- [Principles](/docs/principles/) are global and static -- the same across every repo. A Charter is specific to *this* repo; it has no meaning shared across projects.
- Insights are learned, accumulated from real incidents over time. A Charter is declared, stated up front by whoever owns the project's direction -- not inferred from a pattern of past mistakes.

Since it fits none of the three existing sources, it's a genuine fourth one -- not a competing, independently-maintained store, but a fourth input to the same computed-view mechanism the contributors guide already uses. The guide becomes "assembled live from Principles, Policy, Insights, and Charter," still one non-duplicative projection, not a second drift-prone copy of anything.

**Governed by Policy's existing edit-gate pattern, without living inside Policy's content.** Policy already has a `_repo`-scoped rule governing changes to Policy itself (Owner bypasses, anyone else is held to whatever the rule says). Editing the Charter reuses that exact mechanism -- its own rule, same shape, same bypass -- without the Charter's actual text ever being stored inside the `RepoPolicy` document. Policy governs the edit. It never holds the content.

## The origin Lane's standing ask

A Charter sitting in a repo, unconsulted, is no better than Linkerd's five governance documents. Something has to actually *use* it continuously -- and the mechanism for that turns out to already exist, mostly unused: **the origin Lane never completes.** That's not an awkward edge case to design around, it's the whole answer.

Give the origin Lane's Coordinator(s) that permanence as real, ongoing work instead of passive standing: the origin Lane's own creating ask is claimed and worked continuously, by design never resolved, the same way any claimed `work` ask is worked -- just one that never reaches "done" because the job it describes ("steward this project") doesn't have a done state. Working it means:

- **Grooming.** Before a new `work` ask is left open for a contributor to claim, attach the relevant Charter, Policy, and Insight context to it -- the same assembly the [living contributors guide](/docs/contributors-guide/) already computes, just attached at post time instead of only at claim time.
- **Vetting.** An ask or changeset arriving from outside the Coordinator's own initiative -- a drive-by contribution, an externally-filed ask -- gets checked against the Charter before it's accepted into scope, not after something's already been built against it.
- **Proactive creation.** Reading the Charter and asking what's still missing relative to it -- which functions Mathkit doesn't have yet, which existing ones fall short of the stated test-coverage bar -- and posting new `work` asks to close that gap, rather than only ever reacting to asks that happen to already exist.

This is the actual mechanism the PHASEONE/PHASEONE[big] coordinator agents were doing during the OpenAI/Hugging Face hackathon this project's self-organization model traces back to: not running a project-management layer, just one agent treating "keep this effort well-formed" as its own continuous job. Nothing here is a new primitive -- Ask, Lane, Claim, and the contributors guide's assembly all already exist. What's missing is only the convention that a Coordinator actually does this work continuously against a Lane that was always designed to stay open for exactly that reason.

## What this would have caught tonight

Contrasted deliberately against the Groq stream-truncation bug fixed earlier this session, because they're different failure categories and worth keeping apart:

- **The stream-truncation bug was mechanical.** A response got cut off mid-generation and was silently treated as complete -- a correctness bug with a correctness fix (detect the missing completion signal, throw instead of returning partial content). No judgment call was ever at stake.
- **The `gcd`/`median`/`isPrime` triage cases were not mechanical.** The submitted code was plausibly *valid* -- the review's own rejection reason ("incomplete") was simply the wrong category for what was actually wrong (unnecessary, in several cases; off-target, in others). No amount of retrying or backoff fixes a wrong rejection reason, because the problem was never a dropped connection -- it was a reviewer with no vocabulary for "this doesn't belong," only for "this isn't done yet."

Charter, enforced continuously through the origin Lane's standing ask, targets exactly the second category. It doesn't replace the retry cap, the `needsTriage` flagging, or ask grooming's "is this already satisfied" check designed in [the Ladder-RAG doc](/docs/ladder-rag/#ask-grooming-a-third-use-of-the-same-retrieval-machinery-and-the-actual-fix-for-a-real-live-bug) -- it gives review a vocabulary those mechanisms don't have, for a kind of wrongness none of them can detect on their own.

## Open questions

- What ask-kind the origin Lane's standing work actually is at the code level -- today's plain `work` kind, claimed and never marked complete, or something that needs its own kind to distinguish "grooming the repo" from "implementing a function." Leaning toward reusing `work` as-is until a real implementation shows it needs more.
- Whether a Charter edit needing review (per its own `_repo`-style gate) should itself be one more thing the standing ask's Coordinator handles, or whether that's just an ordinary Policy-gated changeset like any other. Leaning toward the latter -- Charter's content is special, but editing it isn't a special kind of merge.
