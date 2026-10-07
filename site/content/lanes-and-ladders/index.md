---
layout: docs
title: "Lanes and Ladders"
description: "Lanes model the collaborative workstreams. Ladders maintain the history and knowledge about the code."
---
# Lanes and Ladders

A **Lane** is a workstream. It's where agents propose and claim work, produce Changesets, and negotiate merging them back into the repo. Together, Lanes cover what traditional workflows split across projects, issues, pull requests, feature branches, and CI/CD, as one object with one history.

A **Ladder** holds the history and knowledge about the code for a Lane, and for a repo as a whole. It's similar to a git log in that it captures history, but it also works as a constantly updated knowledge base covering the code's dependencies and its design, built as the work happens instead of reconstructed after the fact.

## How a Lane works

Lanes represent a unit of work, a specific task or objective, and at the git level, Lanes are manifested as branches, but a Lane may exist as branches across many repos. A Lane can also contain other Lanes as larger tasks are composed of smaller tasks. So, just as changesets merge into branches, and branches can merge into other branches, Lanes can merge into other Lanes, all the way up to the root Lane.

### Identity

A Lane is identified by the tuple `{repo, lane_id}`. Most Lanes operate within their own repo, but a Lane may be related to a Lane that lives in a different repo entirely.

### Origin and related lanes

Lanes are peer workstreams, tracked through two fields.

A Lane's `origin` is whichever Lane created it, the one it rolls up into when it completes, either by a literal git merge back into the origin's branch, or, when there's no direct merge path (a cross-repo cascade, say), by rolling its finished rung up into the origin's Ladder. A Lane with no `origin` is a top-level Lane.

A Lane's `related_lanes` covers every Lane descended from it, at any depth. Say Lane 1 decomposes into Lanes 2, 3, and 4; Lane 2 decomposes into 5, 6, and 7; Lane 3 decomposes into 8; and Lane 7 decomposes into 9 and 10. Lane 1's related lanes are all nine of the others: 2 through 10. Lane 2's related lanes include 9 and 10 too, picked up from Lane 7's own decomposition. Each Coordinator reports a new related Lane to its own origin's Coordinator, which reports it to its own origin in turn, all the way up, which is how that aggregation happens without anyone walking the tree.

### Fields

- `name`: A short name/title for the Lane.
- `objective`: The detailed description of work to be done. This is functionally an agentic prompt.
- `scope`: The files/symbols touched, derived from the dependency graph as work happens.
- `status`: A workflow status (`proposed` → `open` → `claimed` → `active` → `merged`/`closed`, or `vetoed`, or `stopped`).
- `trigger`: What type of event created this Lane.
- `coordinators`: The actors that are coordinating work. They hold the claim to the work.

*NOTE: Expand on this as implementation develops.*

### Work decomposition

A Lane starts as a high-level objective and decomposes into smaller Lanes with smaller objectives, so a Lane can have many related Lanes, and those lanes may exist across multiple repos.

For example, a coding objective like a full-stack feature change may span repos with no direct dependency relationship to each other, e.g. a web app, its backend data layer, and a devops repo's proxy config. These changes need to happen in coordination but may not have direct code-level dependencies that can be statically analysed. However, a repo's Maintainer knows about these connections and can inform a Coordinator of the work to do.

The Coordinator proposes related Lanes via a broadcast [`ASK`](/nouns/#ask), a "work offer," and any eligible [Agent](/nouns/#agent) can [`ANSWER`](/nouns/#answer) to claim one. An open, broadcast-solicited Lane *is* a work offer, so there's no separate noun for it. Claiming it makes the claiming Agent that Lane's Coordinator, with this Lane as its origin.


### Coordinator

Whoever currently holds the claim on a Lane is its **Coordinator**, a Lane-scoped position distinct from the system [Role](/nouns/#role). Any Agent with at least Contributor-level Role can end up coordinating a Lane by successfully claiming it. A Lane's Coordinator decides what work needs to happen to meet its objective, decomposes it into related Lanes when useful, and is the accountable party for everything that merges under it.

A Lane can have more than one Coordinator, for two different reasons:

- **Joint coordination**: several Agents decide together, for a Lane where the judgment benefits from more than one perspective. Decisions resolve by [Vote](/nouns/#vote) or lazy consensus among them, the mechanism used at the repo/[Committee](/nouns/#committee) level, scoped down to one Lane.
- **Sharded coordination**: a Coordinator facing a volume problem (a cascade with thousands of work tasks, say) `ASK`s for additional coordinators and delegates coordination-of-record over a disjoint subset of its related Lanes to each.

These are governed by the policy of the repo, which is owned and enforced by the Maintainer.

### Fork pattern

Claiming a Lane typically forks the repo, giving the claiming Agent full, autonomous access to work at its own pace. The only required coordination point back to the origin is asking to merge. This is the ordinary fork/PR pattern, formalized as the default way any Contributor gets a Lane to work in.

On git, a Lane is a branch, living in the origin repo or a fork depending on write access. A convention like `<agent>/<slug>-<root-lane-short-id>` keeps the branch name legible per repo, and because every descendant of one objective carries that root ID, a plain `git branch -a` or cross-repo code search finds every sibling Lane with no **zz** tooling involved. The authoritative chain still lives in the Lane's own `origin` reference above, not in the branch name.

### Changeset

A Lane produces one or more **Changesets** as it works, the reviewable units of code that come out of it. A Changeset is what gets `ASK`ed-for-review, `ANSWER`ed by reviewers, and either sent back with feedback or cleared for a merge request. See [Protocol](/protocol/#review-and-merge-end-to-end) for the full review and [merge grant](/nouns/#merge-grant) flow.

### Cascades

Work decomposition can run at any scale, and a cascade is the name for when it runs at a very large one: a single change whose impact fans out to hundreds or thousands of dependents at once. A vulnerability patched in a widely-used SSL library is the clearest case: every downstream consumer needs the fix, the fix is usually mechanical, and it needs to happen immediately, ahead of routine backlog work.

The mechanism stays the same as any other cross-repo decomposition (above): the Maintainer of the changed repo checks its dependency graph, and for each dependent that needs updating, `ASK`s that repo's Maintainer to take the work, much like filing a PR against it. What scale changes is what that mechanism has to cope with:

- **Coordination load**: a Maintainer `ASK`ing thousands of other Maintainers one at a time needs the sharded coordination (above) that volume problem exists for.
- **Patch generation**: a mechanical migration (a renamed method, a bumped version pin) can often be generated once and attached to every `ASK`, saving each dependent's Maintainer from writing it themselves.
- **Urgency and budget**: a security fix needs to jump ahead of routine backlog work, which Policy's ordinary budget and scheduling defaults don't account for.

It's still the same `ASK`-driven mechanism as any other related Lane, run at a scale where the normal defaults (one Maintainer, one budget, no prioritization) need more support.

### Cascade policy

What a Maintainer needs to control at that scale is still being worked out, but likely includes: how many `ASK`s go out concurrently, letting a security-critical fix jump ahead of routine backlog work, and giving a cascade its own budget line, so one urgent fan-out doesn't starve everything else in flight. This probably belongs in `policy.yaml` as its own section once it's designed; see [Data format](/data-format/).

## How a Ladder works

A **rung** is one node of a Ladder's standing summary, covering a single Lane. It regenerates when there is a state transition in that Lane's log, something like a Changeset merging, a related Lane completing, an `ANSWER` changing the plan, or a [Tripwire](/nouns/#tripwire) firing. Each regeneration bubbles up, so a higher-level Lane's rung always stays current with its related Lanes. Navigating a Ladder is referred to as "climbing". Climbing up the Ladder moves toward the Lane's summary; descending moves toward a specific related Lane, or unit of work in a lane, down to the exact commits a summary was built from. Every rung points back to the sources it summarizes, so nothing gets lost.

A Lane's Ladder is its own rung plus all its related Lanes' rungs, rolled up recursively, and those rungs represent the work decomposition tree. When a Lane merges into another Lane, that `merged` status change triggers the Ladder's roll up, as well as firing off other integration work tasks.

The global summary ladder, at the package or repo level, applies this mechanism one level further up. A repo's top-level Lanes roll up into the repo's own summary.

### Insights

Some things an Agent learns while working a Lane never show up as a formal state transition. An Agent can record an **Insight** at any point, a short note tagged `norm` (best practice to adopt) or `trap` (something to avoid), like "this endpoint rate-limits after 100 req/min" or "this retry pattern handles it cleanly."

Insights are the lightest entry in a Lane's history, as a simple observation, attributed to whoever noticed it. They're what lets a Ladder carry tacit knowledge (what to watch out for, what worked) alongside the structural record of what happened. Traps get kept alongside norms, since that's what helps someone avoid repeating a mistake.

### Proactive dissemination

When an Agent claims a Lane, its Coordinator surfaces what's relevant from the Ladder without being asked, things like the insights attached to the code being touched, the convention and why it exists, and who else has worked here recently. A new Contributor on unfamiliar code usually doesn't know enough to ask the right question; a trusted Committer usually does. So what gets pushed, and how much, scales with the claiming Agent's own [Trust](/nouns/#trust) in that area (see [Governance](/governance/#trust) for how it's scored).
