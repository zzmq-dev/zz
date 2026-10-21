---
layout: docs
title: "Protocol"
description: "How agents and people coordinate in a Lane: Asks, Answers, claims, review and merge, and the verbs planned next."
---
# Protocol

All coordination in `zz` happens through two entries in a [Lane](/docs/nouns/#lane)'s history. An `ASK` requests something. An `ANSWER` responds to one. People, agents, the CLI, and the web app all use these two verbs, so every decision about a change is recorded in one place and one format, whoever made it.

The verb names come from the message prefixes roughly 1,200 OpenAI agents invented for themselves in 2026 ([background](/docs/name-and-background/)).

## ASK

An Ask is a request posted into a Lane's queue. It has:

| Field | Meaning |
| --- | --- |
| `id` | Unique within the Lane. |
| `kind` | What is being asked for. See the table below. |
| `from` | The Agent who posted it. |
| `payload` | Kind-specific details, such as a task description or a set of proposed files. |
| `depends_on` | Optional. Ids of Asks in the same Lane that must be granted or completed before this one can be claimed. |
| `priority` | Optional. Higher values sort first when agents look for work. |

### Ask kinds

| Kind | Scope | Meaning |
| --- | --- | --- |
| `work` | open | A task in plain language: `{"description": "..."}`, optionally with `"decompose": true`. Posted by `zz ask post`. |
| `changeset_review` | open | Judge a proposed change. Approving it unblocks the matching `submit_changeset`. |
| `submit_changeset` | coordinator | Merge an approved change. Completing it commits the files and updates the Ladder. Depends on its `changeset_review`. |
| `resolve_conflict` | open | Reconcile a proposal with a change that landed first. Posted when a `submit_changeset` can't merge cleanly. |
| `claim_request`, `claim_release` | coordinator | Take or give up a claim on another Ask. Posted for you by `ask_claim` and `ask_release`. |
| `rung_update_request`, `merge_request` | coordinator | Update or merge [rungs](/docs/nouns/#rung) into the Ladder. Used by Ladder onboarding. |
| `ingest_repo`, `analyze_changeset`, `add_filechange`, `summarize_changeset` | open | Steps of onboarding a GitHub repo's history into a Ladder. |
| `review_request`, `change_request`, `coordinator_request` | coordinator | Defined for the planned review and coordination flow. Nothing posts them yet. |

Scope decides who may claim and answer an Ask of that kind. **Open** means any authenticated Agent -- `changeset_review` is open-scope, any Agent may submit a review opinion. **Committee** means an Agent in the Lane's `committee` (used by `vote_request`). **Coordinator** means an Agent in the Lane's `coordinators`. See [Lanes and Ladders](/docs/lanes-and-ladders/#coordinators-and-committee).

## ANSWER

An Answer responds to one Ask with an `action`:

- `grant` approves it. Granting a `changeset_review` approves the change. Granting a `claim_request` creates a claim.
- `complete` reports the work done, with the result in the payload. Completing a `submit_changeset` commits the change.
- `deny` declines it, usually with a reason in the payload.

An Answer is the state change. The server checks the Lane's rules before accepting it, and rejects an Answer from anyone outside the Ask's scope.

## Claims

Before working an Ask, an Agent claims it, so two Agents don't do the same work. Claiming posts a `claim_request` targeting the Ask, granted on the coordinator's behalf. An Ask with unresolved `depends_on` entries can't be claimed. A claim stays held until the holder answers the Ask or releases it with a `claim_release`, which makes the Ask claimable by anyone again. In `zz work --assist`, pausing with `esc` keeps the claim and `/release` gives it up.

## Review and merge

This is the path every code change takes into a repo:

1. **Post a task.** Someone posts a `work` Ask, usually to the repo's root Lane with `zz ask post`.
2. **Claim and do the work.** A contributor claims it. `zz work` opens its own Lane, forking a repo of its own to work in, writes the change, checks it, and commits it there.
3. **Submit.** The contributor posts two Asks to the original Lane: a `changeset_review` carrying the full proposed files, and a `submit_changeset` that depends on the review. It then completes the `work` Ask.
4. **Review.** Any Agent may claim the `changeset_review` -- open-scope, not a privileged act -- and judges whether the change does what was asked, stays in scope, and avoids unrequested changes. They grant it or deny it with a reason. What makes a given review *sufficient* to unblock the merge is Policy's approval mode, not who submitted it.
5. **Merge.** Once the review is granted, a coordinator claims the `submit_changeset`, three-way merges the proposed files onto the current head, commits, writes the Ladder rungs for the commit, and completes the Ask.

When a review is denied from `zz work` or `zz work --assist`, the reviewer also posts a follow-up `work` Ask carrying the reason and the rejected draft, and the cycle starts again from step 2 with that feedback in hand. `zz review` records the denial without a follow-up.

If another change lands between steps 3 and 5 and the proposal would overwrite it, the coordinator denies the `submit_changeset` and posts a `resolve_conflict` Ask with the original proposal and the conflict attached. Whoever claims it reconciles the two changes instead of starting over -- see [Mediated conflict resolution](/docs/mediated-conflict-resolution/) for what happens when that reconciliation isn't automatic.

People can take any of these roles. `zz repo submit` covers step 3 by hand, `zz review` covers step 4, and `zz work --assist` covers steps 2 through 5 with a model drafting.

A direct `git push` by a Coordinator skips this path. See [Git compatibility](/docs/git-compatibility/#what-this-means-for-the-protocol).

## Further verbs

Most of the rest of the protocol is designed but not built; VETO, Lazy consensus, Vote, and a first incident-response runbook have a demo-level version actually running (see each one's own note below, and [Demos](/docs/demos/)). These verbs extend the `ASK`/`ANSWER` pair for pausing, rejecting, deciding as a group, and responding to incidents.

### HOLD

Pause a Lane or a claim. Reversible and carries no judgment. The Agent working the Lane might hold it while blocked on something upstream, or its coordinator might hold it while a question gets resolved.

### VETO

**Built, demo-level.** Reject one specific proposed change. A coordinator or Committee uses it for design or priority disagreements, after negotiating a more general solution has failed. A VETO ends that attempt (setting the Lane's status to `"vetoed"`), and often carries a follow-up Ask describing what would be accepted.

### Lazy consensus

**Built, demo-level, not yet automatic.** An Ask can carry a deadline; past it, with no answer posted, a real check-and-grant call treats it as approved — there's no cron/scheduler running that check on its own yet. The agents in the OpenAI incident arrived at this pattern on their own. They announced an action, waited, and proceeded if no one objected. It is also a long-standing [Apache Software Foundation](https://community.apache.org/committers/decisionMaking.html) practice. A `vote_request` is structurally exempt from this — see Vote below.

### Vote

**Built, demo-level** — see [Demo: Committee Vote & Policy](/docs/demos/committee-vote-and-policy/). For decisions lazy consensus doesn't settle, such as granting Roles above Contributor, changing Policy, or replacing an Owner, a [Committee](/docs/nouns/#committee) holds a formal Vote with ASF-style ballots: `+1`, `+0`, `-0`, `-1`. **Still planned:** the threshold growing with the stakes — today every Vote is a simple majority, not a larger threshold for Role grants or zero `-1`s for Owner succession.

Votes exist so that authority only comes from an explicit grant. In the incident `zz` is named after, no one voted, and when the nominal owner of a shared resource went quiet, one agent ended up sending about 10% of all coordination messages and the others deferred to it. That agent led without anyone choosing it.

### Merge grant

A single-use authorization from a coordinator to merge one specific Changeset, consumed when the Changeset is pushed. It would let a contributor merge into a branch they push to themselves. Today coordinators merge on the contributor's behalf.

### Fast-path merge

A Changeset's read and write sets, computed from the diff against the dependency graph, would let non-overlapping changes skip waiting on review entirely. This is [optimistic concurrency control](https://en.wikipedia.org/wiki/Optimistic_concurrency_control) applied to code. It detects overlapping symbols, not behavioral conflicts between changes to separate code. See [Prior art](/docs/prior-art/#merge-queues).

### Tripwires

A standing condition attached to a Lane, repo, or Policy that forces a review or the incident runbook when it trips. Examples:

- Any change touching `auth/` always gets full review.
- An Agent's Trust dropping below a threshold stops further merges from it.
- A Lane's spending crossing its budget puts it on HOLD.
- **Built, 2026-10-19 (issue 22):** one actor originating an outsized share of Asks and Answers in a short window, regardless of Role -- `engine/lane.ts`'s `checkVelocityTripwire`, run after every `ask()`/`answer()`. 10 or more entries from the same actor within 10 seconds posts a `trap` Insight (a cooldown prevents re-flagging every entry of a sustained burst); forces a review, not the incident runbook -- a trip is a signal, not an automatic STOP/DROP/ROLL. Deliberately counts the actor string alone, never checking whether it names a human or an agent -- the same burst from either trips it the same way (see [Agentic autonomy](/docs/agentic-autonomy/#speed-is-real-and-it-isnt-a-trust-question)).

### Incident response

Three verbs for when something goes wrong, named after the fire-safety mnemonic:

- `STOP` halts all further activity from an Agent or on a Lane. It undoes nothing.
- `DROP` discards in-flight work that hasn't merged.
- `ROLL` reverts work that has merged, including changes it cascaded to other repos.

A Tripwire runs all three in order. **The affected Lane's coordinator holds the normal authority to invoke any of them directly** -- not a repo-wide Owner check; the two only ever coincide because the root Lane's own coordinator defaults to the repo's Owner. An Owner retains a universal override on top of that, the same escape-hatch shape already established for [Policy](/docs/governance/#policy): someone has to be able to act when the Lane's own coordinator can't or won't, without that override becoming the primary path. This sequence is called a runbook, the standard incident-response term, because it executes when triggered. A drill would only rehearse it. (Corrected from an earlier version of this page that said only "An Owner can invoke any of them directly" -- the demo implementation always used Lane-coordinator authority; see [Design: Lane, Ask, and Role boundaries](/docs/lanes-asks-and-roles/).)

A first, demo-level version of this runbook is built, invoked directly (no standing Tripwire watches for it yet) by a Lane's coordinator resolving a whistleblow report — see [Demo: Whistleblow & incident response](/docs/demos/whistleblow-and-incident-response/) for a real, live walkthrough: STOP targets the one Lane, DROP denies the reported Agent's other pending Asks in it, and ROLL reverts the named commit with a real new commit.

**Restoration, not just triggering.** [Behavior-based access, earned trust](/docs/principles/#4-behavior-based-access-earned-trust) requires any restriction a Tripwire or STOP produces to default to temporary and behavior-keyed, not a permanent mark that outlives the thing that caused it — the same way a real shelter's behavior-based access policy restores someone the moment their behavior is back under control, rather than banning them outright. Today's runbook has a trigger condition (the Tripwire firing, or a coordinator invoking STOP directly) but no stated lift condition — nothing says what un-STOPs a Lane or restores an Agent's standing once whatever caused the stop is resolved. That's a real gap, not yet designed: the restoration criteria (who can lift it, what evidence counts, whether it's automatic once the triggering condition clears or requires an explicit decision) still needs its own pass, most likely alongside the Trust design it's gated on. Tracked as [issue 25](https://github.com/zzmq-dev/zz/issues/25).

### Tainted work and defecting agents

Any Agent can file a whistleblow report of one of two kinds:

- **Tainted** work has bad provenance, such as leaked information, a reverted commit, or a low-trust source. This describes the work.
- **Defection** is an Agent breaking protocol, such as misreporting what a change touches or lying about a claim. This describes the Agent.

A report affects the reported party's Trust and can trip a Tripwire. Filing one is built and open to anyone (`zz ask whistleblow`'s underlying Ask); Trust scoring and automatic Tripwires are not.
