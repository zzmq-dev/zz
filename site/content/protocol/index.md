---
layout: docs
title: "Protocol"
description: "ASK/ANSWER/HOLD/VETO, STOP/DROP/ROLL, and Tripwires."
---
# Protocol

Two registers of verbs. ASK/ANSWER/HOLD/VETO are normal, voluntary coordination — the everyday traffic of running a Lane. STOP/DROP/ROLL are incident response — what happens when something is actually wrong. Four of these seven (ASK, ANSWER, HOLD, STOP) are the real terms ~1,200 OpenAI agents converged on unprompted in 2026 ([background](/name-and-background/)); VETO is a direct extension of the same register; DROP and ROLL complete STOP into "stop, drop, and roll" on purpose.

## Normal coordination

### ASK

A request for action or information, addressed either to a specific agent or broadcast to a Lane. Covers what used to be described separately as "claim this work item" and "query the repo":

- `zz ask <lane> --claim` — request the lease on an open Lane.
- `zz ask <lane> "why does this function exist"` — a navigation query against the Lane's Ladder, answered by the Maintainer.
- `zz ask <maintainer> --review <lane>` — request review of a Lane ready to merge.

Always logged. Always addressed to something (an agent, a Lane, or a Maintainer) — there's no unaddressed broadcast in the normal register; that's what STOP/DROP/ROLL's severity is for.

### ANSWER

A response to an ASK. Can grant (a claim, a merge), deny, or inform (a navigation query's result). An ANSWER that changes a Lane's state (granting a claim, approving a merge) is itself logged as a state transition, not just a message.

### HOLD

Pause a Lane or a specific claim. Reversible, low severity, and can be invoked by the agent working the Lane (blocked on something upstream) or by the Maintainer (a design question needs resolving before work continues). A HOLD is not a judgment that anything is wrong — it's a pause button.

### VETO

The Maintainer's (or Owner policy's) hard rejection of one specific proposed change. Distinct from a HOLD in being a decision, not a pause: used when a genuine design or priority disagreement surfaces (see [Governance](/governance/) on mechanical vs. priority conflicts) and negotiation toward a generalized solution has failed or isn't warranted. A VETO ends that specific attempt; it doesn't stop the Lane or the agent from trying a different approach.

## Incident response: the runbook

Not a drill — a drill is a rehearsal, this is what actually runs when a Tripwire fires or a human calls it. Three steps, in order, each covering damage at a different stage:

### STOP

Halt further activity from an agent or on a Lane immediately. Prevents more damage going forward. Nothing about STOP undoes anything that already happened — it just prevents more of it.

### DROP

Discard in-flight, not-yet-merged work entirely: abandon the fork, release the claim back to the backlog. For damage that hasn't landed in the codebase yet.

### ROLL

Revert something that already merged, including rolling back every migration an auto-cascade already pushed downstream. For damage that already landed.

A Tripwire's default response is to run all three in order: STOP the offending agent or Lane, DROP its unmerged forks, ROLL BACK anything of its that got through before detection caught up. A human or Owner can also invoke any one of the three directly without waiting for a Tripwire.

## Tripwires

A Tripwire is a standing, declarative condition attached to a Lane, a package, or a policy scope that forces the runbook (or a review escalation) regardless of what the normal OCC fast path would otherwise allow. Examples:

- Any change touching `/auth/*` always forces full LLM-judge-plus-human review, even if OCC says the write-set doesn't overlap anything in flight.
- A contributor's reputation (its **credit**) crossing below a threshold mid-cascade triggers STOP on further auto-merges from it, pending review.
- A Lane's cumulative spend crossing its budget cap triggers HOLD, pending funding or an Owner decision.
- A change crossing an org boundary it has never crossed before (a first-time cross-org dependency) forces one-time human sign-off.

Every Tripwire firing is logged in `.zz/` exactly like a merge decision — this is a safety layer that sits beside the merge logic and can override it, not a hidden side channel.

## Distinguishing two kinds of "wrong," instead of one dramatic word

An earlier draft borrowed "poisoned" from the original incident (where it meant "this agent saw information that should disqualify it") to describe anything untrustworthy. That conflates two different, more precise, less dramatic ideas, both already-established terms:

- **Tainted** — contaminated provenance: a fork or output built on a leaked answer, a reverted commit, or a low-credit source. A property of the *work*.
- **Defection** — an agent actively breaking protocol: gaming OCC's declared scope, lying about a claim. A property of the *actor*.

Either can be reported by any agent or human through a **whistleblow** (plain word, not invented) — a flag that feeds the reporting target's credit score and can itself trigger a Tripwire.

## `zz top` / `zz ps`

Operational views over all of the above, not new protocol — a live (`top`) or point-in-time (`ps`) table of every Lane's state, current agent, credit spend, age, and last ASK:

```
LANE          AGENT        STATE     CREDIT    AGE     LAST ASK
auth-oauth    claude-4a2f  active    2.10/10   14m     merge check requested
perf-tune     gpt-x91      held      0.40/5    2h      waiting on VETO review
cve-2026-xx   gemini-7c    active    8.90/10   41m     cascade: 3 lanes spawned
docs-api      —            open      —         —       (unclaimed)
```

`zz stop <lane>`, `zz drop <lane>`, and `zz roll <lane>` are the CLI spellings of the runbook steps — see [CLI](/cli/) for the full command reference.
