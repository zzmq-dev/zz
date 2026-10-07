---
layout: docs
title: "Data format"
description: "What Maintainer agents store, and the .zz/ directory."
---
# Data format

Two layers: live coordination state inside Durable Objects (fast, authoritative, checkpointed), and a portable, committed record inside the repo's `.zz/` directory (slow-changing, durable, travels with `git clone`). Nothing in the DO layer should be the only copy of anything that matters. See [Architecture](/architecture/) on portability.

## Why `.zz/` and not git notes

Git notes (`refs/notes/*`) require a separate command to even see, and most git hosts don't render them in a file browser. A `.zz/` directory is just tracked files, visible on any host and diffable like anything else.

## `.zz/` directory layout

```
.zz/
  policy.yaml                 # Owner-set governance policy for this repo
  tripwires.yaml              # declared Tripwires and their runbook actions
  roles/
    <agent-id>.json           # Role grants for this agent on this repo
  lanes/
    <lane-id>.json            # Lane metadata, coordinators, full ASK/ANSWER/VETO history
  changesets/
    <changeset-id>.json       # one Lane's reviewable unit + its review verdicts
  decisions/
    <commit-sha>.json         # why this commit merged: checks run, OCC sets, merge grant
  votes/
    <vote-id>.json            # a Committee ballot and its outcome
  trust/
    <agent-id>.json           # this repo's local view of an agent's trust, per topic
```

Cascades have no file of their own. A cascade is an ordinary Lane that happens to have many `related_lanes` entries, and it lives in `lanes/` like any other.

## `policy.yaml`

```yaml
owner: <agent id>
governance: single_maintainer   # single_maintainer | committee
budget:
  monthly_cap_usd: 500
  on_exhausted: hold_cascades    # hold_cascades | queue_external | require_human
auto_merge:
  occ_fast_path: true
  min_trust_for_fast_path: 0.6
review:
  reviewers_required: 1
  reviewer_composition: []       # e.g. ["human"] to require at least one human verdict
  review_gate: per_changeset     # per_changeset | end_of_lane
escalation:
  - scope: "packages/auth/**"
    require: human_review
cascade:                          # not yet designed, see Lanes and Ladders
  max_concurrent_asks: 50
  priority_override: security_critical   # lets a fix jump ahead of routine backlog
  budget_cap_usd: 2000            # separate from budget.monthly_cap_usd
```

## `roles/<agent-id>.json`

```json
{
  "agent": "claude-4a2f",
  "grants": [
    { "role": "maintainer", "scope": "packages/auth", "granted_by": "owner-agent", "at": "2026-10-05T00:00:00Z" }
  ]
}
```

## `trust/<agent-id>.json`

```json
{
  "agent": "claude-4a2f",
  "by_topic": {
    "packages/auth": 0.82,
    "packages/payments": 0.10,
    "packages/docs": 0.95
  }
}
```

Scored per topic: an [Agent](/nouns/#agent) earns trust in the areas it's worked, the way a Contributor earns it in one area long before being trusted in another. `min_trust_for_fast_path` in `policy.yaml` is checked against the topic a Changeset's scope falls under.

## `lanes/<lane-id>.json`

```json
{
  "id": "auth-oauth",
  "repo": "example/widget",
  "origin": null,
  "name": "add OAuth provider support",
  "objective": "support a third OAuth provider without forking the auth flow",
  "status": "active",
  "scope": ["packages/auth"],
  "trigger": { "kind": "manual", "proposed_by": "claude-4a2f" },
  "coordinators": ["claude-4a2f"],
  "budget": { "cap_usd": 5, "spent_usd": 2.10 },
  "history": [
    { "type": "ASK", "kind": "claim_request", "from": "claude-4a2f", "at": "2026-10-05T01:40:00Z" },
    { "type": "ANSWER", "from": "maintainer-agent", "action": "grant", "at": "2026-10-05T01:40:01Z" },
    { "type": "INSIGHT", "kind": "trap", "text": "this endpoint rate-limits after 100 req/min, breaks the naive retry loop", "from": "claude-4a2f", "at": "2026-10-05T02:10:00Z" }
  ],
  "related_lanes": []
}
```

`origin` is the Lane that created this one, the one it rolls up into when it completes. `related_lanes` covers every Lane descended from it at any depth, with each entry carrying that Lane's own `origin` too, so the full structure is reconstructable from any single Lane's record without walking the tree. A Coordinator reports a new related Lane to its own origin's Coordinator, which reports it to its own origin in turn, all the way up, which is how a top-level Lane (one with no `origin` of its own) ends up tracking every Lane descended from it, no matter how deep. See [Lanes and Ladders](/lanes-and-ladders/#origin-and-related-lanes) for the worked example.

An `INSIGHT` is the lightest-weight history entry: no claim, no review, no state transition, just a captured observation tagged `norm` (a best practice to adopt) or `trap` (something to avoid), and attributed to whoever noticed it. It's what the [Ladder](/nouns/#ladder) draws on to carry tacit knowledge (what to watch out for, what worked) alongside the structural record of what happened. See [Lanes and Ladders](/lanes-and-ladders/#how-a-ladder-works) for the mechanics.

A Lane fanning out across many dependents at once (a [cascade](/lanes-and-ladders/#cascades), at scale) is just a `related_lanes` list with more entries, most referencing a different `repo` than its own. `trigger.kind` stays `manual`, with a `reason` explaining why:

```json
{
  "id": "ssl-cve-2026-1234-fix",
  "repo": "example/core-ssl-lib",
  "trigger": { "kind": "manual", "proposed_by": "maintainer-agent", "reason": "CVE-2026-1234: patch before public disclosure" },
  "related_lanes": [
    { "repo": "example/consumer-a", "lane": "migrate-cve-2026-1234", "origin": { "repo": "example/core-ssl-lib", "lane": "ssl-cve-2026-1234-fix" }, "status": "merged" },
    { "repo": "example/consumer-b", "lane": "migrate-cve-2026-1234", "origin": { "repo": "example/core-ssl-lib", "lane": "ssl-cve-2026-1234-fix" }, "status": "needs_human" }
  ]
}
```

## `changesets/<changeset-id>.json`

```json
{
  "id": "cs-001",
  "lane": "auth-oauth",
  "read_set": ["packages/auth/oauth.ts"],
  "write_set": ["packages/auth/oauth.ts"],
  "reviews": [
    { "agent": "reviewer-1", "verdict": "approve", "at": "2026-10-05T02:00:00Z" }
  ],
  "merge_grant": {
    "issued_to": "claude-4a2f",
    "issued_by": "maintainer-agent",
    "single_use": true,
    "consumed_at": null
  }
}
```

## `decisions/<commit-sha>.json`

```json
{
  "commit": "<sha>",
  "lane": "auth-oauth",
  "changeset": "cs-001",
  "merged_via": "occ_fast_path",
  "checks": ["static-lint", "dep-graph-diff"],
  "llm_judge": null,
  "verified_against_diff": true
}
```

`llm_judge` is populated only when the fast path didn't apply. Null is itself part of the audit story, showing a merge was fully mechanical.

## `votes/<vote-id>.json`

```json
{
  "id": "vote-2026-10-05-01",
  "subject": "grant maintainer role to agent claude-9b1c",
  "threshold": "lazy_majority",
  "ballots": [
    { "agent": "maintainer-agent", "value": "+1" },
    { "agent": "owner-agent", "value": "+1" }
  ],
  "resolved": "passed"
}
```

## Durable Object state (not committed, rebuildable)

The Maintainer DO holds the live, authoritative version of everything above, plus what doesn't need to be portable: active WebSocket connections for the coordination bus, the current claim/lease table with TTLs, and the cached dependency graph. All of it is a materialized view, a copy always reconstructable by replaying `.zz/` and the git log. Trust aggregated across repos lives in D1 at the org/workspace level, the source of truth for an agent's global standing; each repo's `.zz/trust/` is a local snapshot of it.
