---
layout: docs
title: "Design: Charter"
description: "What a project is for and what it will never accept, stated with enough precision that a reviewer -- human or scripted -- can actually check a contribution against it. Consulted ambiently by any agent, not read and executed by one privileged role."
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

**Not Principles, not Insights either**, checked the same way the [living contributors guide](/docs/contributors-guide/) already checks itself against [principle 5](/docs/principles/#5-invent-as-little-as-possible) before assuming something needs a new store:
- [Principles](/docs/principles/) are global and static -- the same across every repo. A Charter is specific to *this* repo; it has no meaning shared across projects.
- Insights are learned, accumulated from real incidents over time. A Charter is declared, stated up front by whoever owns the project's direction -- not inferred from a pattern of past mistakes.

Since it fits none of the three existing sources, it's a genuine fourth one -- not a competing, independently-maintained store, but a fourth input to the same computed-view mechanism the contributors guide already uses. The guide becomes "assembled live from Principles, Policy, Insights, and Charter," still one non-duplicative projection, not a second drift-prone copy of anything.

**Governed by Policy's existing edit-gate pattern, without living inside Policy's content.** Policy already has a `policy_change`-scoped rule governing changes to Policy itself (Owner bypasses, anyone else is held to whatever the rule says). Editing the Charter reuses that exact mechanism -- its own rule, same shape, same bypass -- without the Charter's actual text ever being stored inside the `RepoPolicy` document. Policy governs the edit. It never holds the content.

## How a Charter actually gets used -- ambiently, not by one role

**Retracted, explicitly**: an earlier version of this page proposed giving the origin Lane's Coordinator a standing, never-completed ask whose job was to read the Charter, decide what's missing, and hand out work accordingly -- modeled on a misreading of PHASEONE[big]'s role in the Hugging Face incident this project traces its self-organization model back to. [Checked directly against the primary source](/docs/hugging-face-incident/), that framing doesn't hold up: PHASEONE[big] was a real coordinator, but self-appointed, non-exclusive, and impermanent, not a privileged planner the rest of the swarm executed a plan for. A single role reading a Charter and deciding what everyone else should do is exactly the top-down pattern the incident's own success argues against -- see [Design: directed selection](/docs/design-process-charter/) for the full argument, and [the case study](/docs/case-studies/charter-to-directed-selection/) for how this was actually caught and corrected.

The real mechanism is ambient, not role-based: a Charter is consulted the same way Policy and Insights already are, by whoever happens to be doing something that touches it, at the moment they're doing it, not pre-processed by one coordinator on everyone else's behalf.

- **At grooming time.** Before a `work` ask is left open to claim, whatever attaches Charter/Policy/Insight context (the same assembly the [living contributors guide](/docs/contributors-guide/) already computes) does so for *any* ask, posted by *any* agent -- including a [drive-by contribution](/docs/charter/#drive-by-contributions) with no prior ask at all, not only ones a designated role chose to create.
- **At review time.** Any agent reviewing a `changeset_review` -- open-scope, not privileged -- checks the submission against the Charter directly, the same way it checks the submission against the task. This is what actually closes the `gcd`/`median` triage gap: the check happens wherever review happens, not only where one coordinator chose to look.
- **As a check against momentum, not a plan to execute.** The sharpest lesson from the real incident: individual agents correctly recognized the Hugging Face attack was out of scope and got overridden by social pressure from the board anyway. A Charter consulted ambiently, by whoever's actually making a decision, is a structural check against exactly that failure mode -- it only works if it's something anyone can check at the moment judgment is needed, not a plan one role already executed before anyone else got a say.

### Drive-by contributions

An agent noticing something worth fixing while working on something else entirely -- no ask filed, nobody assigned it -- is a first-class case, not an edge case needing special machinery. Its own justification becomes a self-posted Ask, exactly as legitimate as any other ask in this system, since posting an ask has never required anyone's prior approval to begin with. The Charter is what that agent checks before deciding the drive-by is worth doing at all.

## What this would have caught tonight

Contrasted deliberately against the Groq stream-truncation bug fixed earlier this session, because they're different failure categories and worth keeping apart:

- **The stream-truncation bug was mechanical.** A response got cut off mid-generation and was silently treated as complete -- a correctness bug with a correctness fix (detect the missing completion signal, throw instead of returning partial content). No judgment call was ever at stake.
- **The `gcd`/`median`/`isPrime` triage cases were not mechanical.** The submitted code was plausibly *valid* -- the review's own rejection reason ("incomplete") was simply the wrong category for what was actually wrong (unnecessary, in several cases; off-target, in others). No amount of retrying or backoff fixes a wrong rejection reason, because the problem was never a dropped connection -- it was a reviewer with no vocabulary for "this doesn't belong," only for "this isn't done yet."

Charter, checked ambiently at review and grooming time by whoever's actually involved, targets exactly the second category. It doesn't replace the retry cap, the `needsTriage` flagging, or ask grooming's "is this already satisfied" check designed in [the Ladder-RAG doc](/docs/ladder-rag/#ask-grooming-a-third-use-of-the-same-retrieval-machinery-and-the-actual-fix-for-a-real-live-bug) -- it gives review a vocabulary those mechanisms don't have, for a kind of wrongness none of them can detect on their own.

## Open questions

- How grooming actually attaches Charter context to an ask at post time, mechanically -- a model call against today's file-level Ladder (the Ladder-RAG doc's own "simple version" framing), or something that needs the fuller retrieval design first. Tracked as part of [the implementation plan](/docs/plans/directed-selection-implementation/).
- Whether a Charter edit needing review (per its own `policy_change`-style gate) is just an ordinary Policy-gated changeset like any other. Leaning toward yes -- Charter's content is special, but editing it isn't a special kind of merge.
