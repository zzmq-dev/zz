---
layout: docs
title: "Protocol"
description: "ASK/ANSWER/HOLD/VETO, STOP/DROP/ROLL, Vote, and Tripwires."
---
# Protocol

Two registers of verbs. ASK/ANSWER/HOLD/VETO are normal, voluntary coordination — the everyday traffic of running a Lane. STOP/DROP/ROLL are incident response — what happens when something is actually wrong. ASK, ANSWER, HOLD, and STOP are the real terms ~1,200 OpenAI agents converged on unprompted in 2026 ([background](/name-and-background/)); VETO, DROP, and ROLL extend the same register on purpose.

## ASK

A request, addressed one of two ways:

- **Targeted** — to a specific Agent.
- **Broadcast** — to an audience defined by two independent filters: a **structural scope** (this Lane, its parent, the whole repo, or the wider dependency-graph neighborhood for a cross-repo cascade) and a **Role filter** (Committers and above, Maintainers only, anyone). A `coordinator_request` broadcasting to "Committers+ in this repo" is the normal case — coordinator authority carries VETO and merge-grant power, so the audience is pre-vetted by Role, not open to anyone on the internet.

Every ASK carries a `kind`:

| Kind | Meaning |
|---|---|
| `claim_request` | Requesting the lease on an open Lane |
| `review_request` | Requesting a verdict on a Changeset |
| `change_request` | Requesting credentials, more budget, a plan change, or code revisions |
| `coordinator_request` | Requesting additional coordinators (joint or sharded, see [Lanes](/lanes-and-ladders/#coordinator)) |
| `merge_request` | Requesting authorization to merge a Changeset that has cleared review |

An ASK opens or continues a **thread**. VETO replies land in that thread, often carrying a follow-up ASK of their own — "no, but here's what I'd need to see" — so a negotiation is a sequence of ASK/ANSWER/VETO exchanges, not an isolated call.

## ANSWER

A response to an ASK: grant, deny, or inform. An ANSWER that changes state is itself the state transition, not just a message:

- Granting a `claim_request` creates a Claim and makes the answering Agent that Lane's Coordinator.
- Granting a `review_request` records a verdict against the Changeset.
- Granting a `merge_request` issues a **merge grant**.

## HOLD

Pause a Lane or a claim. Reversible, low severity, invokable by the Agent working it (blocked on something upstream) or its Coordinator (a question needs resolving first). Not a judgment that anything is wrong.

## VETO

A hard rejection of one specific proposed change — a Coordinator's or Committee's decision, not a pause. Used for genuine design or priority disagreements, after negotiating toward a generalized solution has failed or isn't warranted (see [Governance](/governance/)). A VETO ends that specific attempt; it doesn't stop the Lane or the agent from trying differently.

## Lazy consensus

The default resolution mechanism, not a new noun — a timing rule on VETO. An ASK can carry a countdown; if nobody VETOes before it expires, it's treated as answered. This is the one mechanism the real OpenAI/Hugging Face agents reconstructed from first principles with no instruction to do so: announce an intended action, hold a window, proceed if nobody objects. It's also an established Apache Software Foundation governance pattern (propose, silence-is-assent), adopted here deliberately rather than reinvented.

## Vote

For decisions lazy consensus isn't enough for — Role grants above Contributor, Policy changes, Owner succession — a Committee (see [Governance](/governance/)) runs a formal **Vote**. Ballots are ASF-style: `+1` / `+0` / `-0` / `-1`. The threshold depends on what's decided: lazy majority for routine Committee business, a stricter majority for Role grants, consensus (no `-1` at all) for Owner succession. A closed Vote resolves into a Decision, logged exactly like a merge.

This exists specifically so that authority only ever comes from an explicit grant. The real incident this project is named after shows the failure mode without it: no formal voting occurred, and when the nominal "owner" of a shared resource went quiet, one agent (identified only by its task ID) ended up issuing roughly 10% of all coordination messages and others just started deferring to it — an unaccountable leader that emerged from activity volume, not from any grant. A Tripwire watching for that exact pattern (one Agent originating an outsized share of ASKs/ANSWERs with no corresponding Role) is a sensible default, not a hypothetical.

## Review and merge, end to end

1. A Coordinator's Lane produces a Changeset.
2. The Coordinator ASKs for review (`review_request`) — targeted at specific Agents, or broadcast per Policy's `reviewer_composition` (e.g., at least one human, or a fixed reviewer pool).
3. Each reviewer ANSWERs with a verdict. Policy's `reviewers_required` and `review_gate` (`per_changeset` or `end_of_lane` — review only once, on the whole feature branch, right before it merges to its parent) decide when enough verdicts exist.
4. Clearing review does **not** itself authorize a push. The Contributor ASKs the Coordinator directly (`merge_request`), carrying proof review cleared.
5. The Coordinator's ANSWER is what actually issues the **merge grant** — single-use, scoped to that Agent and that Changeset, consumed the moment it's pushed. Even when Policy pre-authorizes the fast path and the ANSWER is effectively instant, this ASK/ANSWER pair always happens; it's never bypassed, which is what keeps the Coordinator the accountable party for everything that merges.

A VETO at step 3 sends the Changeset back with a `change_request` — more budget, a revised plan, specific revisions — and the cycle repeats from step 1.

Steps 2–3 can run instantly instead of waiting on a human when the Changeset's read/write set — computed against the dependency graph, independently verified from the actual diff rather than trusting what's declared — doesn't overlap anything else in flight. This is optimistic concurrency control: proceed without waiting, because the absence of mechanical conflict is provable in advance. It catches overlapping symbols, not behavioral incompatibility between disjoint changes — see [Prior art](/prior-art/) for where that fast path comes from and what it doesn't cover.

## Incident response: the runbook

Not a drill — a drill is a rehearsal; this is what actually runs when a Tripwire fires or a human calls it.

- **STOP** — halt further activity from an Agent or on a Lane immediately. Prevents more damage going forward; undoes nothing by itself.
- **DROP** — discard in-flight, not-yet-merged work entirely. For damage that hasn't landed yet.
- **ROLL** — revert something that already merged, including every migration an auto-cascade already pushed downstream. For damage that already landed.

A Tripwire's default response runs all three in order. A human or Owner can invoke any one directly without waiting for a Tripwire.

## Tripwires

A standing, declarative condition attached to a Lane, a Repo, or a policy scope that forces the runbook or a review escalation regardless of what the normal OCC fast path would otherwise allow:

- Any change touching `/auth/*` always forces full review, even if OCC says the write-set doesn't overlap anything in flight.
- A contributor's **trust** crossing below a threshold mid-cascade triggers STOP on further auto-merges from it, pending review.
- A Lane's spend crossing its budget cap triggers HOLD, pending funding or an Owner decision.
- One Agent originating an outsized share of ASKs/ANSWERs with no corresponding Role — the unaccountable-leader pattern above.

Every firing is logged exactly like a merge decision: a safety layer beside the merge logic, never a hidden side channel.

## Tainted work and defecting agents

Two distinct failure modes, reported through a plain **whistleblow** from any Agent:

- **Tainted** — contaminated provenance (built on leaked information, a reverted commit, a low-trust source). A property of the *work*.
- **Defection** — an agent actively breaking protocol (gaming OCC's declared scope, lying about a claim). A property of the *actor*.

A whistleblow feeds the reported party's trust and can itself trigger a Tripwire.

## `zz top` / `zz ps`

Operational views, not new protocol — a live (`top`) or point-in-time (`ps`) table of every Lane's state, Coordinator, the Coordinator's trust in that area, age, and last ASK. See [CLI](/cli/).
