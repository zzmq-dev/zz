---
layout: docs
title: "Data format design"
description: "The original storage design, including the planned .zz/ directory and policy.yaml."
---
# Data format design

> **Archived.** This is a design or planning document from earlier in the project. It records the reasoning at the time it was written and may describe plans that changed or were never built. See the [Archive](/docs/archive/) index for context, or the [Overview](/docs/overview/) for how `zz` works today.

Three layers: live coordination state inside Durable Objects (fast, authoritative, checkpointed), a portable, committed record inside the repo's `.zz/` directory (slow-changing, durable, travels with `git clone`), and repo-level metadata (description, policy, Role grants) on a dedicated `zz-meta` orphan branch. Nothing in the DO layer should be the only copy of anything that matters. See [Architecture](/docs/architecture/) on portability.

## Why `.zz/` and not git notes -- and why repo metadata is neither

Git notes (`refs/notes/*`) require a separate command to even see, and most git hosts don't render them in a file browser. A `.zz/` directory is just tracked files, visible on any host and diffable like anything else -- that's still right for Lane/changeset/decision history, which belongs alongside the code it's about. (The Ladder itself is the one exception: it's carried in git notes after all, since its anchors are commits and blobs rather than paths -- see [the remote backend](/docs/remote-backend/) for why.)

Repo-level metadata (description, policy, Role grants) is different: it isn't *about* any particular commit, it changes on its own schedule, and every write to it would otherwise be a commit cluttering the repo's real history. It lives on its own orphan branch, `zz-meta`, instead -- same portability guarantee (travels with `git clone -b zz-meta`), without the noise.

## `.zz/` directory layout

```
.zz/
  tripwires.yaml              # declared Tripwires and their runbook actions
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

## `zz-meta` branch layout

```
meta.json     # description, policy, owner
roles.json    # repo-level Role grants
lanes.db      # checkpointed export of the DO's live Lane/Ask/Answer state
```

## `meta.json`

```json
{
  "description": "a widget-manufacturing library",
  "policy": { "require_changeset_review": true, "visibility": "public" },
  "owner": { "type": "account", "id": "acct-1a2b3c4d" },
  "created_at": "2026-10-12T00:00:00Z"
}
```

`policy` is the minimal cut of the fuller `policy.yaml` sketched in an earlier draft of this doc (budget/cascade/escalation policy, below) -- `require_changeset_review` and `visibility` are what's enforced today; the rest is roadmap.

## `roles.json`

Repo-level Role grants -- the coarse layer (see [Governance](/docs/governance/)): a repo's Owner/Maintainer status applies across every Lane in it, unlike a Lane's own `coordinators`/`maintainers`, which is the fine-grained, per-Lane Claim.

```json
{
  "grants": [
    { "principal": "account:acct-1a2b3c4d", "role": "owner", "granted_by": "system", "at": "2026-10-05T00:00:00Z" },
    { "principal": "agent:agent-9f8e7d6c", "role": "maintainer", "granted_by": "account:acct-1a2b3c4d", "at": "2026-10-06T00:00:00Z" }
  ]
}
```

A principal is `"account:<id>"` or `"agent:<id>"` -- see [accounts and the web app](#accounts-and-the-web-app) below for what those are. `engine/roles.ts`'s path-scoped `RoleGrant`/`AgentRoles` (a grant scoped to a directory prefix, e.g. `packages/auth`) is a separate, finer-grained mechanism for a later pass; nothing here is scoped below the whole repo yet.

## Policy roadmap (not yet enforced)

```yaml
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

## Accounts and the web app

Accounts, agents, agent tokens, login sessions, and the cross-repo repo index that back [zzbin.dev](https://zzbin.dev)'s `/explore` and repo pages live in Cloudflare D1, not in any repo's own history -- they have no git home (a human's login identity isn't a property of any one repo). The `repos` table there is explicitly an index/cache of each repo's own `zz-meta` branch, never the only copy of a load-bearing fact, same rule as everywhere else in this doc.

An **account** is a human, created on first login (Cloudflare or Google OAuth -- not GitHub). An **agent** belongs to exactly one account and authenticates with its own bearer token; it can hold repo Roles, create repos, and act as a Lane coordinator just like a human can, but its owning account can always see and override its grants.

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

Scored per topic: an [Agent](/docs/nouns/#agent) earns trust in the areas it's worked, the way a Contributor earns it in one area long before being trusted in another. `min_trust_for_fast_path` in `policy.yaml` is checked against the topic a Changeset's scope falls under.

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

`origin` is the Lane that created this one, the one it rolls up into when it completes. `related_lanes` covers every Lane descended from it at any depth, with each entry carrying that Lane's own `origin` too, so the full structure is reconstructable from any single Lane's record without walking the tree. A Coordinator reports a new related Lane to its own origin's Coordinator, which reports it to its own origin in turn, all the way up, which is how a top-level Lane (one with no `origin` of its own) ends up tracking every Lane descended from it, no matter how deep. See [Lanes and Ladders](/docs/lanes-and-ladders/#decomposition) for the worked example.

An `INSIGHT` is the lightest-weight history entry: no claim, no review, no state transition, just a captured observation tagged `norm` (a best practice to adopt) or `trap` (something to avoid), and attributed to whoever noticed it. It's what the [Ladder](/docs/nouns/#ladder) draws on to carry tacit knowledge (what to watch out for, what worked) alongside the structural record of what happened. See [Lanes and Ladders](/docs/lanes-and-ladders/#ladders) for the mechanics.

A Lane fanning out across many dependents at once (a [cascade](/docs/lanes-and-ladders/#cascades), at scale) is just a `related_lanes` list with more entries, most referencing a different `repo` than its own. `trigger.kind` stays `manual`, with a `reason` explaining why:

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
