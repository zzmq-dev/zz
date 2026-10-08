---
layout: docs
title: "MCP"
description: "The three tool surfaces agents use to work in zz: git, ladder/lanes, and roles."
---
# MCP

Agents interact with `zz` through three tool surfaces, alongside the `zz` CLI. All three started as in-process functions (see `cli/commands/ladder-build.ts` and `ladder-replay-commits.ts`) before becoming standalone servers — the same local-process-first sequencing the rest of the engine follows.

## zz-git

Read-only data fetching: cloning, walking commit history, reading a file at a given commit, and the GitHub-specific metadata (issues, PRs, releases, contributors). Nothing here writes anything.

```
git.ensure_cloned(repo)
git.log(repo, { first_parent })
git.diff(repo, commit, { path? })
git.show_file(repo, commit, path)
gh.fetch_issues / fetch_pull_requests / fetch_releases / fetch_contributors(repo)
gh.fetch_thread_comments(repo, number)
```

## zz-ladder-lanes

The Ask/Answer/Lane/Ladder surface: proposing a Lane, posting and claiming Asks, answering them, and the two tools that actually mutate a repo's Ladder.

```
ladder.read(repo, path)
ladder.dump(repo, { format })
ladder.merge(repo, rung_or_rungs)                       # coordinator-gated; the only write path
ladder.update_rung(repo, path, { changeSummary, commit }) # coordinator-gated
lanes.propose(repo, { name, objective, origin, scope, coordinators })
lanes.get(repo, lane_id)
asks.post(repo, lane_id, { kind, payload, depends_on?, priority? })
asks.query_claimable(repo, lane_id, actor)
asks.claim(repo, lane_id, ask_id)
asks.answer(repo, lane_id, ask_id, { action, payload })
```

## zz-roles

Who holds what Role, where. Barely exists yet; `engine/roles.ts` has the enforcement logic, not yet exposed as tools.

```
roles.my_repos_and_roles(actor)    # what an agent should even look at
roles.grant / roles.revoke / roles.list(repo)   # admin-only
```

## What's a tool versus what's a skill

The test for whether the tool surface above is complete: an agent given one sentence ("ingest this repo into zz") plus a skill describing the conventions should be able to derive the whole multi-step process on its own, without a hardcoded sequence. If it needs a capability that isn't one of the tools above, that's a gap in this design, not something to patch with more hardcoded script.

**Skill: ingesting a repo.** The procedural knowledge an agent loads before attempting this, not a tool call:

- The repo's root is one long-lived Lane, id `_repo`, origin none, never completes. Propose it if `lanes.get` returns nothing.
- Walk `git.log` oldest-first. For each commit not already present at `ladder.read(repo, "changesets/<sha>")`, post an `analyze_changeset` ask into a session Lane.
- To analyze a changeset: propose its own Lane. For each changed file, post an `add_filechange` ask; post one `summarize_changeset` ask with `depends_on` set to all of them. A commit touching an unusually large number of files gets one mechanical note per file instead of per-file/per-hunk analysis — that depth is noise at that size, not signal.
- `add_filechange`: describe what changed, and separately fire a `rung_update_request` at `_repo` so the file's current-state rung stays current. That update should synthesize a fresh description of the file's current state, not append the latest change onto the old one — a cosmetic change (formatting, whitespace) shouldn't alter the substantive description at all.
- When a changeset Lane's queue drains, post one `merge_request` to `_repo` with the assembled rung as payload, and move on without waiting for it to be processed.
- Onboard issues/PRs, releases, contributors, and dependencies the same way: mechanical fetch via zz-git, judgment via the model, write via `ladder.merge`.

**System prompt sketch:**

> You are an agent in the zz coordination system. You hold Roles in specific repos — call `roles.my_repos_and_roles` to find out which, and at what scope. Work exists as Asks posted to a Lane's queue, each with a payload describing what's needed. Call `asks.query_claimable` for the repos/lanes you're eligible for, pick one, claim it, do the work with whatever tools apply, and answer it — often by proposing new Lanes and posting new Asks for sub-work you don't finish yourself. Never call `ladder.merge` unless you're actually the Lane's coordinator for that scope; otherwise post the merge as an Ask and let the owning Lane's coordinator process it.

**The Ask that should replace a hardcoded ingest script entirely:**

```
kind: "ingest_repo"
payload: {
  description: "Ingest github.com/forwardemail/supertest into zz: walk its
  commit history from the root commit forward, building one changeset per
  commit with its file-level (and, for reasonably-sized commits, line-level)
  breakdown, keeping each file's current-state rung up to date as you go.
  Also onboard its issues, PRs, releases, contributors, and dependencies.
  Skip anything already present."
}
```

## Open questions

- Auth and scoping: how an MCP tool call carries the same Auth Token and Role scoping the CLI and protocol already require.
- Whether zz-git, zz-ladder-lanes, and zz-roles end up as one server or three — grouped separately above because they have different trust boundaries (zz-git never writes; zz-ladder-lanes' two write tools are coordinator-gated; zz-roles' writes are admin-only), not because the split is final.
- Tool granularity within each group: one broad query tool or several narrow ones.
