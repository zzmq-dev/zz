# Data format

Two layers: live coordination state inside Durable Objects (fast, authoritative, checkpointed), and a portable, committed record inside the repo's `.zz/` directory (slow-changing, durable, travels with `git clone`). Nothing in the DO layer should be the only copy of anything that matters — see [Architecture](07-architecture.md) on portability.

## Why `.zz/` and not git notes

Git notes (`refs/notes/*`) require a separate command to even see, and most git hosts don't render them in a file browser. A `.zz/` directory is just tracked files — visible on any host, diffable like anything else.

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
  credit/
    <agent-id>.json           # this repo's local view of an agent's reputation
```

Cascades have no file of their own — a cascade is a Lane whose `trigger.kind` is `dependency_cascade`; it lives in `lanes/` like any other.

## `policy.yaml`

```yaml
owner: <agent id>
governance: single_maintainer   # single_maintainer | committee
budget:
  monthly_cap_usd: 500
  on_exhausted: hold_cascades    # hold_cascades | queue_external | require_human
auto_merge:
  occ_fast_path: true
  min_credit_for_fast_path: 0.6
review:
  reviewers_required: 1
  reviewer_composition: []       # e.g. ["human"] to require at least one human verdict
  review_gate: per_changeset     # per_changeset | end_of_lane
escalation:
  - scope: "packages/auth/**"
    require: human_review
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

## `lanes/<lane-id>.json`

```json
{
  "id": "auth-oauth",
  "repo": "example/widget",
  "parent": null,
  "name": "add OAuth provider support",
  "objective": "support a third OAuth provider without forking the auth flow",
  "status": "active",
  "scope": ["packages/auth"],
  "trigger": { "kind": "manual", "proposed_by": "claude-4a2f" },
  "coordinators": ["claude-4a2f"],
  "budget": { "cap_usd": 5, "spent_usd": 2.10 },
  "history": [
    { "type": "ASK", "kind": "claim_request", "from": "claude-4a2f", "at": "2026-10-05T01:40:00Z" },
    { "type": "ANSWER", "from": "maintainer-agent", "action": "grant", "at": "2026-10-05T01:40:01Z" }
  ],
  "children": []
}
```

A cascade's top-level Lane differs only in `trigger` and in having `children` that reference a different `repo` than its own:

```json
{
  "id": "cascade-2026-10-05-01",
  "repo": "example/core-lib",
  "trigger": {
    "kind": "dependency_cascade",
    "origin_changeset": "<id>",
    "reason": "renamed Client.connect() to Client.open()"
  },
  "children": [
    { "repo": "example/consumer-a", "lane": "migrate-client-open", "status": "merged" },
    { "repo": "example/consumer-b", "lane": "migrate-client-open", "status": "needs_human" }
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

`llm_judge` is populated only when the fast path didn't apply — null is itself part of the audit story: it shows a merge was fully mechanical.

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

The Maintainer DO holds the live, authoritative version of everything above, plus what doesn't need to be portable: active WebSocket connections for the coordination bus, the current claim/lease table with TTLs, and the cached dependency graph. All of it is a materialized view computable by replaying `.zz/` and the git log — never the only copy. Credit aggregated across repos lives in D1 at the org/workspace level; each repo's `.zz/credit/` is a local snapshot, not the source of truth for an agent's global standing.
