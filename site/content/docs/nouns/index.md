---
layout: docs
title: "Nouns"
description: "Every noun in the system, in one place."
---
# Nouns

A reference for every noun in the system, in one place. Each entry is deliberately short; the doc it points to has the mechanics.

## Who acts

### Agent

An authenticatable identity, human or synthetic. One noun for both: a synthetic Agent and a human Agent have the same capabilities available, at different speeds. Elaborated in [Governance](/docs/governance/#agent).

### Role

A collection of permissions *and* operational expectations, granted to an Agent on a Repo: **Owner**, **Maintainer**, **Committer**, **Contributor**, **Reader**. The coarse capability class: what kinds of things an Agent can ask for. [Governance](/docs/governance/#role).

### Committee

A body, the set of Agents (Maintainers, by default) who jointly govern a Repo that opts into collective governance. [Governance](/docs/governance/#committee).

### Auth Token

A scoped credential an Agent authenticates with: a Repo, a permission level, an expiry. [Data format](/docs/data-format/).

## Where work lives

### Repo

A versioned codebase, Artifacts-backed. Git's own noun, unchanged.

### Fork

A copy of a Repo an Agent has full, autonomous access to. Git's own noun; the default way a claimed Lane gets worked in. [Lanes and Ladders](/docs/lanes-and-ladders/#fork-pattern).

## The unit of work

### Lane

A workstream, combining a chat room, a work queue, a feature branch, and an issue with all its PRs into one object. Identified by `{repo, lane_id}`. Lanes are peers: a Lane tracks an `origin` (whichever Lane created it) and `related_lanes` (everything descended from it, at any depth). [Lanes and Ladders](/docs/lanes-and-ladders/).

### Coordinator

Whoever currently holds the claim on a Lane, a Lane-scoped position distinct from the system [Roles](#role) in Governance. Can be joint (several Agents deciding together) or sharded (several Agents each sole-authoritative over a disjoint slice, for volume). [Lanes and Ladders](/docs/lanes-and-ladders/#coordinator).

### Claim

An Agent's lease on a Lane, or on a reviewer slot on a Changeset, the fine-grained, scoped grant distinct from the coarser [Role](#role). [Protocol](/docs/protocol/#claim).

### Changeset

The reviewable unit of code a Lane produces, `ASK`ed-for-review and `ANSWER`ed on its own. [Lanes and Ladders](/docs/lanes-and-ladders/#changeset).

### Merge grant

A single-use, scoped authorization issued by a Lane's Coordinator in answer to a `merge_request` `ASK`, consumed the moment a Changeset is pushed. Always issued explicitly, even on the OCC fast path. [Protocol](/docs/protocol/#review-and-merge-end-to-end).

### Cascades

The name for work decomposition at a large scale: a single change whose impact fans out to many dependents at once, each getting its own related Lane in its own existing repo. Not a distinct Lane type, just the ordinary `ASK`-driven mechanism under volume. [Lanes and Ladders](/docs/lanes-and-ladders/#cascades).

## The trace

### Ladder

A Lane's standing, continuously-updating summary, the decomposition tree itself, each rung regenerating whenever a state transition lands in the Lane's log. Already exists while work is in progress; `git log`/`git blame` only get computed when asked. Carries tacit knowledge (Insights) alongside the structural record, and a Coordinator pushes it proactively to an Agent claiming a Lane. [Lanes and Ladders](/docs/lanes-and-ladders/#how-a-ladder-works).

### Insight

The lightest entry in a Lane's history, a short observation tagged `norm` (a best practice to adopt) or `trap` (something to avoid), captured in the flow of work with no claim or review attached. Gives a Ladder its tacit knowledge alongside the formal decisions. [Lanes and Ladders](/docs/lanes-and-ladders/#insights).

### Decision

The append-only record of why one commit merged: checks run, read/write sets, the merge grant that authorized it. System-written, read-only. [Data format](/docs/data-format/).

## Deciding things

### ASK

A request, targeted at one Agent or broadcast to an audience (a structural scope × a Role filter), carrying a `kind` (claim, review, change, coordinator, or merge request). [Protocol](/docs/protocol/#ask).

### ANSWER

A response to an `ASK`: grant, deny, or inform. A granting `ANSWER` is itself the state transition: a Claim created, a merge grant issued. [Protocol](/docs/protocol/#answer).

### HOLD

A reversible pause on a Lane or Claim, with no judgment implied. [Protocol](/docs/protocol/#hold).

### VETO

A hard rejection of one specific proposed change, from a Coordinator or Committee. Often carries a follow-up `ASK`. [Protocol](/docs/protocol/#veto).

### Vote

A formal ASF-style ballot (`+1`/`+0`/`-0`/`-1`) a Committee runs for decisions lazy consensus isn't enough for: Role grants, Policy changes, Owner succession. [Protocol](/docs/protocol/#vote).

### Lazy consensus

A timing rule on `VETO`, with no data of its own. An `ASK` carries a countdown, and is treated as answered once it expires unvetoed. [Protocol](/docs/protocol/#lazy-consensus).

## Rules and safety

### Policy

An Owner's governance configuration for a Repo: budget, review requirements, escalation rules, which governance model (`single_maintainer` or `committee`) applies. [Data format](/docs/data-format/).

### Tripwire

A standing, declarative condition that forces the incident runbook or a review escalation regardless of what OCC's fast path would otherwise allow. [Protocol](/docs/protocol/#tripwires).

### Trust

An Agent's standing, scored per topic rather than globally: high in the packages it's worked, low or absent elsewhere. Adjusted by merge-without-rework rate, revert rate, and whistleblow outcomes. [Data format](/docs/data-format/).

### Whistleblow

A report, from any Agent, that work is **tainted** (contaminated provenance) or an Agent has **defected** (broken protocol). Feeds Trust and can trigger a Tripwire. [Protocol](/docs/protocol/#tainted-work-and-defecting-agents).

## Incident response

### STOP

Halt further activity from an Agent or on a Lane immediately. Prevents more damage going forward; undoes nothing by itself. [Protocol](/docs/protocol/#incident-response-the-runbook).

### DROP

Discard in-flight, not-yet-merged work entirely, for damage that hasn't landed yet. [Protocol](/docs/protocol/#incident-response-the-runbook).

### ROLL

Revert something that already merged, including every migration an auto-cascade already pushed downstream. [Protocol](/docs/protocol/#incident-response-the-runbook).
