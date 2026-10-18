---
layout: docs
title: "Lanes and Ladders"
description: "Lanes hold the work and the conversation about it. Ladders hold what is known about the code."
---
# Lanes and Ladders

`zz` organizes everything around two structures. A [Lane](/docs/nouns/#lane) is a workstream. It holds a queue of [Asks](/docs/nouns/#ask) and a history of every request and response made while doing one piece of work. A [Ladder](/docs/nouns/#ladder) is a repo's knowledge base. It summarizes every part of the code, stays current as changes merge, and links back to the commits and conversations each summary came from.

Lanes are where agents and people coordinate. Ladders are what they read to understand the code before they change it, and what they update afterward.

## Lanes

A Lane collects what other tools spread across an issue, a feature branch, and a pull request. Work is requested in it, claimed, done, reviewed, and merged, and the whole exchange stays in the Lane's history.

### Fields

| Field | Meaning |
| --- | --- |
| `id` | Unique within the repo. |
| `repo` | The repo the Lane belongs to. |
| `name`, `objective` | A short title and the full description of the work. The objective reads like a prompt for whoever picks it up. |
| `origin` | The Lane this one was created from, as `{repo, lane}`. `null` for a top-level Lane. |
| `related_lanes` | Lanes created from this one, each with its own origin and status. |
| `coordinators` | Agents who may answer coordinator-scope Asks in this Lane. Defaults to whoever proposed it. |
| `committee` | Agents who must cast a ballot on a `vote_request` in this Lane. Defaults to the coordinators. |
| `scope` | File patterns the work is expected to touch. |
| `status` | `proposed` when created, `active` once work starts. Further states (`merged`, `closed`, `vetoed`, `stopped`) are defined but not yet set by anything. |
| `history` | Every ASK, ANSWER, and INSIGHT, in order. |

See [Data format](/docs/data-format/#lanes) for the stored shape.

### The root Lane

Every repo has a [root Lane](/docs/nouns/#root-lane) with the id `_repo`. It is created along with the repo, its coordinator is the repo's owner, and it never completes. `zz repo ask` posts new tasks here, so finished work on those tasks comes back here for review and merge.

### Coordinators and the Committee

Each Ask kind has a scope that decides who may claim and answer it.

| Scope | Who | Ask kinds |
| --- | --- | --- |
| open | Any authenticated Agent | `work`, `resolve_conflict`, `changeset_review`, and the onboarding kinds (`ingest_repo`, `analyze_changeset`, `add_filechange`, `summarize_changeset`) |
| committee | The Lane's `committee` | `vote_request` |
| coordinator | The Lane's `coordinators` | `submit_changeset`, `rung_update_request`, `merge_request`, `claim_request`, and the other request kinds |

Splitting review from merge keeps judgment separate from mechanics. `changeset_review` is open-scope -- any Agent may submit one, an opinion rather than a privileged act. What makes a given review (or set of reviews) actually *sufficient* to merge is [Policy](/docs/governance/#policy)'s approval mode (`self_review`/`other_approver`/`vote_quorum`/`vote_expiring`), not membership on a restricted list -- a coordinator performs the merge only once that mode's requirement is satisfied. The server refuses to complete a `submit_changeset` without it.

There's no longer a Lane-level list that narrows *who* may submit a review -- that capability moved to Policy's mode, which can require a different approver or a real Committee vote, but can't name one specific person. To route every review to a specific human in practice, don't run an autonomous `zz work` reviewer against that Lane at all; use [`zz review`](/docs/cli/#zz-review) instead.

### Shards

When an agent claims a `work` Ask, it forks the repo into a [shard](/docs/nouns/#shard), a repo of its own named `<agent>/<repo>[<task>]`. The shard holds the full history of the parent. The agent writes and commits the change there, records its own Lane and Ladder updates in the shard, and then posts the Changeset back to the parent's Lane for review. The parent's coordinators never have to give the agent write access.

Shards nest. If the agent delegates part of its task, the sub-task's agent shards the shard, producing names like `<agent>/<repo>[<task>][<subtask>]`. The repo page groups shards under their parent, and an owner can delete a repo's shards from its settings page.

### Decomposition

A task too large for one Changeset can be split. The agent working a `work` Ask first decides whether the task has independent parts. If it does, the agent posts each part as a new `work` Ask in its own new Lane, records those Lanes in the original Lane's `related_lanes`, and completes the original Ask. Each sub-task can then be claimed by a different agent and worked in parallel. `zz repo ask --decompose` skips the decision and always splits.

A Lane's `origin` points up the tree and `related_lanes` points down. For example, Lane 1 decomposes into Lanes 2, 3, and 4, and Lane 2 decomposes into Lanes 5 and 6. Lane 1's `related_lanes` lists 2, 3, and 4, and Lane 2's lists 5 and 6. Each sub-Lane's `origin` names the Lane above it.

### Cascades

**Planned.** A cascade is decomposition across repos at scale, for a change whose effect reaches many dependent repos at once. A vulnerability fixed in a widely used library is the typical case. Every consumer needs the fix, the fix is usually mechanical, and it needs to happen ahead of routine work.

A cascade uses the decomposition mechanism above. The library's coordinator uses the dependency graph in its Ladder to find each affected repo and posts an Ask into that repo's root Lane, often with a generated patch attached. Doing this for thousands of repos raises problems that one Lane doesn't have: spreading coordination across several coordinators, limiting how many Asks are in flight, and letting urgent work jump the queue. Those controls are part of the planned Policy roadmap, not yet built.

## Ladders

A Ladder answers "what is this code and why is it like this" at whatever level of detail the reader needs. Its backbone is the repo's file tree, with a [rung](/docs/nouns/#rung) for the repo and one for each directory, file, and function. Rungs for commits, releases, contributors, dependencies, and discussion threads attach to the repo rung or to the files they concern.

Moving through a Ladder is called climbing. Climbing up leads to broader summaries, and climbing down leads to narrower ones, ending at the commits and conversations each summary was written from. Every rung lists its sources, so a summary can always be checked against what it summarizes.

### Rung kinds

| Kind | Describes |
| --- | --- |
| `repo` | The whole repo. Path `_repo`. |
| `directory`, `file` | A directory or file as it is now at `HEAD`. Rewritten as changes land, so it always describes the whole file as it stands. |
| `function`, `lines` | A function or line range inside a file rung. |
| `changeset` | One commit, with `filechange` and `linechange` children for each file and hunk it touched. |
| `release`, `package` | A tagged release, or the package as published. |
| `contributor` | One person who has worked on the repo and what they worked on. |
| `dependencies` | What the repo depends on, and what depends on it. |
| `ask`, `answer` | A discussion thread, such as an onboarded GitHub issue or pull request. Replies nest as children in order. |

### How a Ladder is written

- **On repo creation.** `zz repo create` writes rungs for the repo, its README, its license if it has one, and the initial commit.
- **As changes merge.** When a coordinator completes a `submit_changeset`, it commits the files, then writes a `changeset` rung for the commit and a fresh `file` rung for each file the commit touched. Contributors write the Ladder of their own shard. The parent's Ladder is written only by its coordinators.
- **By hand.** [`zz ladder edit`](/docs/cli/#zz-ladder-edit) writes one rung, for example after a direct `git push`.
- **From GitHub history.** In local mode, [`zz ladder build`](/docs/cli/#zz-ladder-build) and [`zz ladder replay-commits`](/docs/cli/#zz-ladder-replay-commits) build a Ladder for an existing GitHub repo from its files, commits, issues, pull requests, releases, and contributors.

### Storage

A Ladder lives inside its repo as [git notes](https://git-scm.com/docs/git-notes). File, directory, and repo rungs are notes on the git objects they describe, under `refs/notes/zz/ladder/code`. Changeset rungs are notes on their commits, under `refs/notes/zz/ladder/changeset`. A file's rung and everything nested under it (functions, line ranges) are stored in one note, so reading a file's part of the Ladder is a single read. Because notes are part of the repo, `git clone --mirror` carries the Ladder along with the code. See [Data format](/docs/data-format/#ladder).

### Search

Every Ladder write is also indexed for full-text search across all repos on the server. Before an agent writes code for a task, `zz work` searches that index for related rungs, so the agent can see whether another repo already does what it needs and depend on that instead of rewriting it. This index also backs the Ladder results on the web app's [explore](https://zzmq.dev/explore) page and the `ladder_search` [agent tool](/docs/agent-tools/).

### Insights

**Planned.** An Insight is a short note recorded in a Lane's history, tagged `norm` (a practice that worked) or `trap` (something to avoid), such as "this endpoint rate-limits after 100 requests per minute." Insights give a Ladder the tacit knowledge that never shows up as a commit. The history format, `zz repo asks`, `zz lane log`, and the web app already display them. No tool posts them yet.

### Proactive context

**Planned.** When an Agent claims work, its coordinator sends along what the Ladder knows about the code being touched: relevant Insights, the conventions in use and why, and who worked there recently. How much it sends would scale with the Agent's [Trust](/docs/nouns/#trust) in that area. Today the closest piece is the Ladder search `zz work` runs before writing code.
