---
layout: docs
title: "Protocol"
description: "ASK/ANSWER/HOLD/VETO, STOP/DROP/ROLL, Vote, and Tripwires."
---
# Protocol

Two registers of verbs. `ASK`/`ANSWER`/`HOLD`/`VETO` are normal, voluntary coordination: the everyday traffic of running a [Lane](/nouns/#lane). `STOP`/`DROP`/`ROLL` are incident response: what happens when something is wrong. `ASK`, `ANSWER`, `HOLD`, and `STOP` are the real terms ~1,200 OpenAI agents converged on unprompted in 2026 ([background](/name-and-background/)); `VETO`, `DROP`, and `ROLL` extend the same register on purpose.

## ASK

A request, addressed one of two ways:

- **Targeted**: to a specific [Agent](/nouns/#agent).
- **Broadcast**: to an audience defined by two independent filters, a **structural scope** (this Lane, its origin, the whole repo, or another repo entirely, whether reached by a dependency-graph cascade or a [Coordinator](/nouns/#coordinator) manually decomposing one objective across repos) and a **Role filter** (Committers and above, Maintainers only, anyone). A `coordinator_request` broadcasting to "Committers+ in this repo" is the normal case, since coordinator authority carries `VETO` and merge-grant power, so the audience is pre-vetted by Role.

Every `ASK` carries a `kind`:

| Kind | Meaning |
|---|---|
| `claim_request` | Requesting the lease on an open Lane |
| `review_request` | Requesting a verdict on a Changeset |
| `change_request` | Requesting credentials, more budget, a plan change, or code revisions |
| `coordinator_request` | Requesting additional coordinators (joint or sharded, see [Lanes](/lanes-and-ladders/#coordinator)) |
| `merge_request` | Requesting authorization to merge a Changeset that has cleared review |

An `ASK` opens or continues a **thread**. `VETO` replies land in that thread, often carrying a follow-up `ASK` of their own, such as "no, but here's what I'd need to see," so a negotiation is a sequence of `ASK`/`ANSWER`/`VETO` exchanges.

## ANSWER

A response to an `ASK`: grant, deny, or inform. An `ANSWER` that changes state is itself the state transition:

- Granting a `claim_request` creates a Claim and makes the answering Agent that Lane's Coordinator.
- Granting a `review_request` records a verdict against the [Changeset](/nouns/#changeset).
- Granting a `merge_request` issues a **merge grant**.

## Claim

The lease an Agent holds on a Lane, or on a reviewer slot on a Changeset, created the moment a `claim_request` `ASK` is granted. It's the fine-grained, scoped grant underneath the coarser [Role](/nouns/#role) (see [Governance](/governance/#role) for the full table): a Role says what kinds of things an Agent can ask for, and a Claim is the scoped authorization for one specific Lane or Changeset. A Committer's elevated Role is what lets it skip the per-Claim grant step a Contributor still needs, with the same underlying git primitives either way.

## HOLD

Pause a Lane or a claim. Reversible, low severity, invokable by the Agent working it (blocked on something upstream) or its Coordinator (a question needs resolving first), with no judgment implied.

## VETO

A hard rejection of one specific proposed change: a Coordinator's or [Committee](/nouns/#committee)'s decision. Used for genuine design or priority disagreements, after negotiating toward a generalized solution has failed or isn't warranted (see [Governance](/governance/#committee)). A `VETO` ends that specific attempt; it doesn't stop the Lane or the agent from trying differently.

## Lazy consensus

The default resolution mechanism: a timing rule on `VETO`. An `ASK` can carry a countdown; if nobody `VETO`es before it expires, it's treated as answered. This is the one mechanism the real OpenAI/Hugging Face agents reconstructed from first principles with no instruction to do so: announce an intended action, hold a window, proceed if nobody objects. It's also an established Apache Software Foundation governance pattern (propose, silence-is-assent), adopted here deliberately.

## Vote

For decisions lazy consensus isn't enough for (Role grants above Contributor, Policy changes, Owner succession), a Committee (see [Governance](/governance/#committee)) runs a formal **Vote**. Ballots are ASF-style: `+1` / `+0` / `-0` / `-1`. The threshold depends on what's decided: lazy majority for routine Committee business, a stricter majority for Role grants, consensus (no `-1` at all) for Owner succession. A closed Vote resolves into a Decision, logged exactly like a merge.

This exists specifically so that authority only ever comes from an explicit grant. The real incident this project is named after shows the failure mode without it: no formal voting occurred, and when the nominal "owner" of a shared resource went quiet, one agent (identified only by its task ID) ended up issuing roughly 10% of all coordination messages and others just started deferring to it: an unaccountable leader that emerged purely from activity volume. A Tripwire watching for that exact pattern (one Agent originating an outsized share of `ASK`s/`ANSWER`s with no corresponding Role) is a sensible default.

## Review and merge, end to end

1. A Coordinator's Lane produces a Changeset.
2. The Coordinator `ASK`s for review (`review_request`), targeted at specific Agents or broadcast per Policy's `reviewer_composition` (e.g., at least one human, or a fixed reviewer pool).
3. Each reviewer `ANSWER`s with a verdict. Policy's `reviewers_required` and `review_gate` (`per_changeset`, or `end_of_lane` for review only once, on the whole feature branch, right before it merges to its origin) decide when enough verdicts exist.
4. Clearing review only makes the Contributor eligible to request a merge. It `ASK`s the Coordinator directly (`merge_request`), carrying proof review cleared.
5. The Coordinator's `ANSWER` is what issues the **merge grant**: single-use, scoped to that Agent and that Changeset, consumed the moment it's pushed. Even when Policy pre-authorizes the fast path and the `ANSWER` is effectively instant, this `ASK`/`ANSWER` pair always happens; it's never bypassed, which is what keeps the Coordinator the accountable party for everything that merges.

A `VETO` at step 3 sends the Changeset back with a `change_request` (more budget, a revised plan, specific revisions), and the cycle repeats from step 1.

Steps 2–3 can run instantly instead of waiting on a human when the Changeset's read/write set, computed against the dependency graph and independently verified from the diff itself rather than trusting what's declared, doesn't overlap anything else in flight. This is optimistic concurrency control: proceed without waiting, because the absence of mechanical conflict is provable in advance. It catches overlapping symbols. Behavioral incompatibility between disjoint changes is a separate problem. See [Prior art](/prior-art/) for where this fast path comes from and its limits.

## Incident response: the runbook

This runs for real, whenever a Tripwire fires or a human calls it (see [Name and background](/name-and-background/) on why "drill" was the wrong word for it).

- `STOP`: halt further activity from an Agent or on a Lane immediately. Prevents more damage going forward; undoes nothing by itself.
- `DROP`: discard in-flight, not-yet-merged work entirely. For damage that hasn't landed yet.
- `ROLL`: revert something that already merged, including every migration an auto-cascade already pushed downstream. For damage that already landed.

A Tripwire's default response runs all three in order. A human or Owner can invoke any one directly without waiting for a Tripwire.

## Tripwires

A standing, declarative condition attached to a Lane, a [Repo](/nouns/#repo), or a policy scope that forces the runbook or a review escalation regardless of what the normal OCC fast path would otherwise allow:

- Any change touching `/auth/*` always forces full review, even if OCC says the write-set doesn't overlap anything in flight.
- A contributor's **trust** crossing below a threshold mid-cascade triggers `STOP` on further auto-merges from it, pending review.
- A Lane's spend crossing its budget cap triggers `HOLD`, pending funding or an Owner decision.
- One Agent originating an outsized share of `ASK`s/`ANSWER`s with no corresponding Role, the unaccountable-leader pattern above.

Every firing is logged exactly like a merge decision: a safety layer beside the merge logic, fully visible.

## Tainted work and defecting agents

Two distinct failure modes, reported through a plain **whistleblow** from any Agent:

- **Tainted**: contaminated provenance (built on leaked information, a reverted commit, a low-trust source). A property of the *work*.
- **Defection**: an agent actively breaking protocol (gaming OCC's declared scope, lying about a claim). A property of the *actor*.

A whistleblow feeds the reported party's trust and can itself trigger a Tripwire.
