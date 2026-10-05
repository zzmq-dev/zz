---
layout: docs
title: "Data format"
description: "What Maintainer agents store, and the .zz/ directory format."
---
# Data format

Two layers: live coordination state inside Durable Objects (fast, authoritative, ephemeral-feeling but checkpointed), and a portable, committed record inside the repo's `.zz/` directory (slow-changing, durable, travels with `git clone`). Nothing in the DO layer should be the only copy of anything that matters — see [Architecture](/architecture/) on portability.

## Why `.zz/` and not git notes

Git notes (`refs/notes/*`) were the original plan for carrying decisions with the repo. Switched to a plain tracked directory instead: notes require a separate command to even see, and most git hosts don't render them in a file browser. A `.zz/` directory is just files — visible on GitHub, GitLab, or a local clone with zero special tooling, and diffable like anything else.

## `.zz/` directory layout

```
.zz/
  policy.yaml                 # Owner-set governance policy for this repo
  tripwires.yaml              # declared Tripwires and their runbook actions
  lanes/
    <lane-id>.json            # Lane metadata + full protocol history
  decisions/
    <commit-sha>.json         # why this commit merged: checks run, OCC sets, who asked
  cascades/
    <cascade-id>.json         # origin pointer + list of spawned lane ids across repos
  credit/
    <agent-id>.json           # this repo's local view of an agent's reputation
```

## `policy.yaml`

```yaml
owner: <human or org id>
budget:
  monthly_cap_usd: 500
  on_exhausted: hold_cascades   # hold_cascades | queue_external | require_human
auto_merge:
  occ_fast_path: true
  min_credit_for_fast_path: 0.6
escalation:
  - scope: "packages/auth/**"
    require: human_review
```

## `lanes/<lane-id>.json`

```json
{
  "id": "auth-oauth",
  "name": "add OAuth provider support",
  "status": "active",
  "scope": ["packages/auth"],
  "owner_agent": "claude-4a2f",
  "budget": { "cap_usd": 5, "spent_usd": 2.10 },
  "history": [
    { "type": "ASK", "from": "claude-4a2f", "action": "claim", "at": "2026-10-05T01:40:00Z" },
    { "type": "ANSWER", "from": "maintainer", "action": "grant", "at": "2026-10-05T01:40:01Z" }
  ],
  "ladder_ref": "ladders/auth-oauth"
}
```

## `decisions/<commit-sha>.json`

```json
{
  "commit": "<sha>",
  "lane": "auth-oauth",
  "merged_via": "occ_fast_path",
  "checks": ["static-lint", "dep-graph-diff"],
  "llm_judge": null,
  "read_set": ["packages/auth/oauth.ts"],
  "write_set": ["packages/auth/oauth.ts"],
  "verified_against_diff": true
}
```

`llm_judge` is populated only when the fast path didn't apply — this field being null is itself part of the audit story: it shows a merge was fully mechanical.

## `cascades/<cascade-id>.json`

```json
{
  "id": "cascade-2026-10-05-01",
  "origin_commit": "<sha in the publishing repo>",
  "reason": "breaking change: renamed Client.connect() to Client.open()",
  "spawned_lanes": [
    { "repo": "consumer-a", "lane": "migrate-client-open", "status": "merged" },
    { "repo": "consumer-b", "lane": "migrate-client-open", "status": "needs_human" }
  ]
}
```

## Durable Object state (not committed, rebuildable)

The Maintainer DO holds the live, authoritative version of everything above, plus the in-memory bits that don't need to be portable: active WebSocket connections for the coordination bus, the current claim/lease table with TTLs, and the cached dependency graph. All of it is a materialized view computable by replaying `.zz/` and the git log — never the only copy. Reputation (**credit**) aggregated across repos lives in D1 at the org/workspace level; each repo's `.zz/credit/` is a local snapshot, not the source of truth for an agent's global standing.
