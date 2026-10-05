# Nouns

A reference for every noun in the system, in one place. Each entry is deliberately short — the doc it points to has the mechanics.

## Who acts

**Agent** — an authenticatable identity, human or synthetic. One noun for both: there's no capability a synthetic Agent has that a human Agent couldn't exercise too, just slower. Elaborated in [Governance](07-governance.md).

**Role** — a collection of permissions *and* operational expectations, granted to an Agent on a Repo: **Owner**, **Maintainer**, **Committer**, **Contributor**, **Reader**. The coarse capability class — what kinds of things an Agent can ask for. [Governance](07-governance.md).

**Committee** — not an individual Role but a body: the set of Agents (Maintainers, by default) who jointly govern a Repo that opts into collective governance. [Governance](07-governance.md).

**Token** — a scoped credential an Agent authenticates with: a Repo, a permission level, an expiry. [Data format](06-data-format.md).

## Where work lives

**Repo** — a versioned codebase, Artifacts-backed. Git's own noun, unchanged.

**Fork** — a copy of a Repo an Agent has full, autonomous access to. Git's own noun; the default way a claimed Lane gets worked in. [Lanes and Ladders](03-lanes-and-ladders.md).

## The unit of work

**Lane** — a workstream: a chat room, a work queue, a feature branch, and an issue with all its PRs, combined into one object. Identified by `{repo, lane_id}`. Lanes nest — a Lane may contain many Lanes. [Lanes and Ladders](03-lanes-and-ladders.md).

**Coordinator** — whoever currently holds the claim on a Lane; a Lane-scoped position, not a system Role. Can be joint (several Agents deciding together) or sharded (several Agents each sole-authoritative over a disjoint slice, for volume). [Lanes and Ladders](03-lanes-and-ladders.md#coordinator).

**Claim** — an Agent's lease on a Lane, or on a reviewer slot on a Changeset. The fine-grained, scoped grant — distinct from the coarser Role. [Protocol](04-protocol.md).

**Changeset** — the reviewable unit of actual code a Lane produces. What gets ASKed-for-review and ANSWERed, not the Lane itself. [Lanes and Ladders](03-lanes-and-ladders.md#changeset).

**Merge grant** — a single-use, scoped authorization issued by a Lane's Coordinator in answer to a `merge_request` ASK, consumed the moment a Changeset is actually pushed. Never issued automatically, even on the OCC fast path. [Protocol](04-protocol.md#review-and-merge-end-to-end).

**Cascade** — not a separate noun: a Lane whose `trigger` is `dependency_cascade` instead of `manual`, with children opened in already-existing dependent repos rather than fresh forks. [Lanes and Ladders](03-lanes-and-ladders.md#cascade).

## The trace

**Ladder** — a Lane's standing, continuously-updating summary: the decomposition tree itself, each rung regenerating whenever a state transition lands in the Lane's log. Unlike `git log`/`git blame`, which are derived on demand, a Ladder already exists while work is in progress. [Lanes and Ladders](03-lanes-and-ladders.md#ladder).

**Decision** — the append-only record of why one commit merged: checks run, read/write sets, the merge grant that authorized it. System-written, read-only. [Data format](06-data-format.md).

## Deciding things

**ASK** — a request, targeted at one Agent or broadcast to an audience (a structural scope × a Role filter), carrying a `kind` (claim, review, change, coordinator, or merge request). [Protocol](04-protocol.md#ask).

**ANSWER** — a response to an ASK: grant, deny, or inform. A granting ANSWER is itself the state transition (a Claim created, a merge grant issued), not just a message. [Protocol](04-protocol.md#answer).

**HOLD** — a reversible pause on a Lane or Claim. Not a judgment that anything is wrong.

**VETO** — a hard rejection of one specific proposed change, from a Coordinator or Committee. Often carries a follow-up ASK.

**Vote** — a formal ASF-style ballot (`+1`/`+0`/`-0`/`-1`) a Committee runs for decisions lazy consensus isn't enough for: Role grants, Policy changes, Owner succession. [Protocol](04-protocol.md#vote).

**Lazy consensus** — the default resolution: an ASK carries a countdown, and is treated as answered if nobody VETOes before it expires. Not a noun with its own data, a timing rule on VETO.

## Rules and safety

**Policy** — an Owner's governance configuration for a Repo: budget, review requirements, escalation rules, which governance model (`single_maintainer` or `committee`) applies. [Data format](06-data-format.md).

**Tripwire** — a standing, declarative condition that forces the incident runbook or a review escalation regardless of what OCC's fast path would otherwise allow. [Protocol](04-protocol.md#tripwires).

**Credit** — a per-Agent reputation score, adjusted by merge-without-rework rate, revert rate, and whistleblow outcomes. Plain word on purpose — no invented term needed.

**Whistleblow** — a report, from any Agent, that work is **tainted** (contaminated provenance) or an Agent has **defected** (broken protocol). Feeds Credit and can trigger a Tripwire. [Protocol](04-protocol.md#tainted-work-and-defecting-agents).

## Incident response

**STOP** / **DROP** / **ROLL** — halt an Agent or Lane; discard its in-flight unmerged work; revert what already merged. The runbook a Tripwire or a human invokes, in that order. Not a drill — the real thing. [Protocol](04-protocol.md#incident-response-the-runbook).
