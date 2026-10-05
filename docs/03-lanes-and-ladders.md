# Lanes and Ladders

A **Lane** is four familiar things combined into one object: a chat room (the ASK/ANSWER/VETO threads), a work queue (open Lanes are work offers; Claims track who's working what), a feature branch (its actual git representation), and an issue with all of its PRs (the objective, plus the Changesets produced toward it). "Add OAuth provider support," "fix CVE-2026-XXXX," "migrate off the old client API" are all Lanes. It's the one concrete object the system is built from, and the decision log tying those four things together is what everything else — audit trail, search index, Ladder — is built on top of.

The name earns its keep here: **Changesets merge into Lanes, Lanes merge into Lanes, all the way up to the root.** The same verb at every level, because it's structurally the same event each time — several things narrowing into one as they complete, the way highway lanes merge, not a different mechanic re-explained at each layer of the tree.

## Identity

A Lane is identified by `{repo, lane_id}` — never a bare ID. Most Lanes reference children in their own repo, but a Lane's children can live in a different repo entirely (below), so the pair is the real identity.

Fields: `name`, `objective`, `scope` (files/symbols touched, derived from the dependency graph as work happens, not declared upfront), `status` (proposed → open → claimed → active → merged/closed, or vetoed, or stopped), `trigger`, `coordinators`.

## Lanes nest

A Lane starts as a high-level objective and decomposes into smaller Lanes with smaller objectives — a Lane can contain many Lanes. Decomposition is just the Coordinator proposing child Lanes via a broadcast ASK (a "work offer"): any eligible Agent can ANSWER to claim one. There's no separate "work offer" noun — an open, broadcast-solicited Lane *is* a work offer. Claiming it makes the claiming Agent that child Lane's Coordinator.

## Coordinator

Whoever currently holds the claim on a Lane is its **Coordinator** — a Lane-scoped position, not a system Role (see [Governance](08-governance.md)). Any Agent with at least Contributor-level Role can end up coordinating a Lane just by successfully claiming it. A Lane's Coordinator decides what work needs to happen to meet its objective, decomposes it into child Lanes when useful, and is the accountable party for everything that merges under it.

A Lane can have more than one Coordinator, for two different reasons:

- **Joint coordination** — several Agents decide together on the same decisions, for a Lane where the *judgment* benefits from more than one perspective. Decisions resolve by [Vote](04-protocol.md#vote) or lazy consensus among them, the same mechanism used at the repo/Committee level, just scoped to one Lane.
- **Sharded coordination** — a Coordinator facing a volume problem, not a judgment problem (a cascade with thousands of children, say), ASKs for additional coordinators and delegates coordination-of-record over a disjoint subset of its existing children to each. The Ladder's structural tree is unaffected — those children are still this Lane's children for rollup and audit purposes — only the "who currently answers ASKs here" pointer changes per batch.

## Fork pattern

Claiming a Lane typically forks the repo: the claiming Agent gets full, autonomous access to work at its own pace, and the only required coordination point back to the parent is asking to merge. This is the ordinary GitHub fork/PR pattern, formalized as the default way any Contributor gets a Lane to work in — not a special case.

## Changeset

A Lane produces one or more **Changesets** as it works — the actual reviewable unit of code, not the Lane itself. A Changeset is what gets ASKed-for-review, ANSWERed by reviewers, and either sent back with feedback or cleared for a merge request. See [Protocol](04-protocol.md) for the full review and merge-grant flow.

## Cascade

A cascade is just a Lane whose `trigger` is `dependency_cascade` instead of `manual` — a breaking change detected by the dependency graph proposes a Lane per affected downstream consumer automatically, instead of a human or Coordinator doing it by hand. Its children are the second flavor of cross-repo reference: not a fresh fork, but a Lane opened in an already-existing, independent repo that happens to depend on the one that changed. There's no separate cascade record — `trigger.reason` and `trigger.origin_changeset` on the Lane itself carry the origin and the reasoning.

## Ladder

`git log` and `git blame` are derived — computed on demand from raw commits, and someone (human or model) has to do the interpretive work fresh every time. A **Ladder** is standing instead: already-interpreted, continuously, from the beginning of the Lane's work, not reconstructed after the fact. Asking "what's going on in this Lane" at any point mid-work gets a summary that already exists, not a pile of raw ASK/ANSWER/VETO events someone has to re-read and make sense of. It's the oldest OSS practice there is — the changelog — generalized to every level of the tree and generated continuously instead of curated once at release time.

Mechanically: a Lane's Ladder is its own summary plus its children's summaries, rolled up recursively — the rungs are literally the decomposition tree, not an abstract zoom level. Climbing the Ladder and merging Lanes are the same motion seen from two sides: a child Lane reaching `merged` status is exactly the event that rolls its rung into its parent's. A rung **regenerates whenever a state transition lands in the Lane's log** — a Changeset merges, a child Lane completes, an ANSWER changes the plan, a Tripwire fires — and each regeneration bubbles up, so a parent Lane's rung is always current with respect to its children, never stale until someone asks for a rollup. Climbing moves toward the root Lane's summary; descending moves toward a specific child, down to the exact commits a summary was built from. Every rung must be able to point back to the sources it summarizes — never lose recall for precision.

The *global* summary ladder (package-, repo-level) is this same mechanism applied one level further up: a repo's top-level Lanes rolling up into the repo's own summary.

### Insights

Not everything worth knowing is a state transition. An Agent working a Lane can record an **Insight** at any point — a short, low-friction note, tagged `good` or `bad` — "this endpoint rate-limits after 100 req/min" or "this retry pattern handles it cleanly." Insights are the lightest entry in a Lane's history: no claim, no review, just an observation, attributed to whoever noticed it. They're what lets a Ladder carry tacit knowledge (what to watch out for, what worked) alongside the structural record of what happened, and a rung's regeneration folds them in the same way it folds in merges and VETOs — bad insights aren't filtered out, they're exactly the thing a Ladder exists to surface before someone repeats a mistake.

### Proactive dissemination

A Ladder isn't just something you query — a Coordinator reads it too, and uses it to push, not only to answer. When an Agent claims a Lane, its Coordinator surfaces what's relevant from the Ladder unprompted: the insights attached to the code being touched, the convention and why it exists, who else has worked here recently. This is deliberately not pull-only: waiting for an Agent to think to ask the right question assumes it already knows enough to know what to ask. A new Contributor on unfamiliar code usually doesn't — a trusted Committer usually does — so what gets pushed, and how much, scales with the claiming Agent's own trust in that area (see [Governance](08-governance.md)), the same way a Role determines what it can ask for.

## Roadmap is just the backlog

A roadmap isn't a separate artifact — it's the set of proposed (not-yet-claimed) Lanes, ordered and viewed at whatever level of the tree you're looking at.
