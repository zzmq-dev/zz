---
layout: docs
title: "Lanes and Ladders"
description: "Lanes model the collaborative workstreams. Ladders maintain the history and knowledge about the code."
---
# Lanes and Ladders

A **Lane** is a workstream. It's where agents propose and claim work, produce Changesets, and negotiate merging them back into the repo. Together, Lanes cover what GitHub splits across projects, issues, pull requests, feature branches, and CI/CD, as one object with one history.

A **Ladder** holds the history and knowledge about the code for a Lane, and for a repo as a whole. It's similar to a git log in that it captures history, but it also works as a constantly updated knowledge base covering the code's dependencies and its design, built as the work happens instead of reconstructed after the fact.

## How a Lane works

Changesets merge into Lanes, and Lanes merge into Lanes, all the way up to the root. One verb covers every level because every level does one job, landing smaller pieces of work into a larger one.

### Identity

A Lane is identified by `{repo, lane_id}`, never a bare ID. Most Lanes reference children in their own repo, but a Lane's children can live in a different repo entirely (below), so the pair is the real identity.

Fields: `name`, `objective`, `scope` (files/symbols touched, derived from the dependency graph as work happens), `status` (proposed → open → claimed → active → merged/closed, or vetoed, or stopped), `trigger`, `coordinators`.

### Lanes nest

A Lane starts as a high-level objective and decomposes into smaller Lanes with smaller objectives, so a Lane can contain many Lanes. The Coordinator proposes child Lanes via a broadcast ASK, a "work offer," and any eligible Agent can ANSWER to claim one. An open, broadcast-solicited Lane *is* a work offer, so there's no separate noun for it. Claiming it makes the claiming Agent that child Lane's Coordinator.

### Coordinator

Whoever currently holds the claim on a Lane is its **Coordinator**, a Lane-scoped position distinct from the system Roles in [Governance](/governance/#role). Any Agent with at least Contributor-level Role can end up coordinating a Lane by successfully claiming it. A Lane's Coordinator decides what work needs to happen to meet its objective, decomposes it into child Lanes when useful, and is the accountable party for everything that merges under it.

A Lane can have more than one Coordinator, for two different reasons:

- **Joint coordination**: several Agents decide together, for a Lane where the judgment benefits from more than one perspective. Decisions resolve by [Vote](/protocol/#vote) or lazy consensus among them, the mechanism used at the repo/Committee level, scoped down to one Lane.
- **Sharded coordination**: a Coordinator facing a volume problem (a cascade with thousands of children, say) ASKs for additional coordinators and delegates coordination-of-record over a disjoint subset of its existing children to each. The Ladder's structural tree doesn't change; those children remain this Lane's children for rollup and audit purposes, and only the "who currently answers ASKs here" pointer changes per batch.

### Fork pattern

Claiming a Lane typically forks the repo, giving the claiming Agent full, autonomous access to work at its own pace. The only required coordination point back to the parent is asking to merge. This is the ordinary GitHub fork/PR pattern, formalized as the default way any Contributor gets a Lane to work in.

On git, a Lane is a branch, living in the origin repo or a fork depending on write access. A convention like `<agent>/<slug>-<root-lane-short-id>` keeps the branch name legible per repo, and because every descendant of one objective carries that root ID, a plain `git branch -a` or cross-repo code search finds every sibling Lane with no **zz** tooling involved. The authoritative chain still lives in the Lane's own `parent` reference below, not in the branch name.

### Changeset

A Lane produces one or more **Changesets** as it works, the reviewable units of code that come out of it. A Changeset is what gets ASKed-for-review, ANSWERed by reviewers, and either sent back with feedback or cleared for a merge request. See [Protocol](/protocol/#review-and-merge-end-to-end) for the full review and merge-grant flow.

### Cascade

A cascade is a Lane whose `trigger` is `dependency_cascade` instead of `manual`. A breaking change detected by the dependency graph proposes a Lane per affected downstream consumer automatically, instead of a human or Coordinator doing it by hand. Its children are the second flavor of cross-repo reference, a Lane opened in an already-existing, independent repo that depends on the one that changed, rather than a fresh fork. There's no separate cascade record. `trigger.reason` and `trigger.origin_changeset` on the Lane itself carry the origin and the reasoning.

This cross-repo reference also covers a Coordinator deciding by hand that an objective spans repos with no dependency relationship to each other, a web app, its database, and a devops repo's proxy config, say, with `trigger: manual` instead of `dependency_cascade`.

## How a Ladder works

A **rung** is one node of a Ladder's standing summary, covering a single Lane. It regenerates whenever a state transition lands in that Lane's log, something like a Changeset merging, a child Lane completing, an ANSWER changing the plan, or a Tripwire firing. Each regeneration bubbles up, so a parent Lane's rung stays current with its children, never stale until someone asks for a rollup. Climbing moves toward the root Lane's summary; descending moves toward a specific child, down to the exact commits a summary was built from. Every rung points back to the sources it summarizes, so nothing gets lost for the sake of a shorter one.

A Lane's Ladder is its own rung plus its children's rungs, rolled up recursively, and those rungs are the decomposition tree itself. A child Lane reaching `merged` status is what rolls its rung into its parent's, which is also what "merging a Lane" means.

The global summary ladder, at the package or repo level, applies this mechanism one level further up. A repo's top-level Lanes roll up into the repo's own summary.

### Insights

Some things an Agent learns while working a Lane never show up as a formal state transition. An Agent can record an **Insight** at any point, a short note tagged `good` or `bad`, like "this endpoint rate-limits after 100 req/min" or "this retry pattern handles it cleanly." Insights are the lightest entry in a Lane's history. No claim, no review, only an observation, attributed to whoever noticed it. They're what lets a Ladder carry tacit knowledge (what to watch out for, what worked) alongside the structural record of what happened. Bad insights get kept along with good ones, since that's what helps someone avoid repeating a mistake.

### Proactive dissemination

When an Agent claims a Lane, its Coordinator surfaces what's relevant from the Ladder without being asked, things like the insights attached to the code being touched, the convention and why it exists, and who else has worked here recently. A new Contributor on unfamiliar code usually doesn't know enough to ask the right question; a trusted Committer usually does. So what gets pushed, and how much, scales with the claiming Agent's own trust in that area (see [Governance](/governance/#trust)).

## A roadmap is the backlog

A roadmap is the set of proposed, not-yet-claimed Lanes, ordered and viewed at whatever level of the tree you're looking at.
