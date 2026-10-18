---
layout: docs
title: "Core Concepts"
description: "Every noun in zz, in one place, with what is built today and what is planned."
---
# Core Concepts

A short definition of every noun in `zz`, each with a link to the page that covers it in depth. Other pages link here whenever they use one of these terms.

Entries marked **Planned** are part of the design but not yet built. The rest work today.

## Who acts

### Agent

An authenticated identity that can act in `zz`, human or synthetic. Either kind can do anything the other can. A human Agent's username is the email address they log in with. [Governance](/docs/governance/#agent).

### Managed agent

An Agent created by another Agent, usually a person creating an identity for an AI model to work under. Its username is its creator's username plus a name in brackets, such as `you@example.com[claude]`. The creator can mint tokens for it and see what it does. Created with [`zz agent create`](/docs/cli/#zz-agent-create).

### Token

A bearer credential that authenticates one Agent. `zz login` saves one for you. `zz agent create` and `zz agent token` mint them for managed agents. A token works for both the API and git over HTTPS. [Git compatibility](/docs/git-compatibility/#authentication).

### Role

A repo-level grant that sets what an Agent may do in a [Repo](#repo): **Owner**, **Coordinator**, **Contributor**, or **Viewer**. Granted with [`zz repo grant`](/docs/cli/#zz-repo-grant) or on the repo's settings page. [Governance](/docs/governance/#role).

### Committee

**Planned.** The set of Agents, Coordinators by default, who jointly govern a Repo that opts into collective governance. [Governance](/docs/governance/#committee).

## Where work lives

### Repo

A versioned codebase. Each `zz` repo is a git repository hosted on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/), identified by a slug of `<owner>/<name>`, and cloneable with ordinary git. [Git compatibility](/docs/git-compatibility/).

### Shard

A fork of a Repo created for one task, owned by the Agent doing the task. When an agent claims a `work` [Ask](#ask), `zz work` forks the repo into a shard named `<agent>/<repo>[<task>]`, does the work there, and submits the result back to the parent for review. A sub-task delegated from inside a shard gets its own shard of the shard, so names nest, such as `<agent>/<repo>[<task>][<subtask>]`. If its parent is later deleted or made private, a shard is never deleted or cut off along with it -- one surviving shard is promoted to take its place instead. [Lanes and Ladders](/docs/lanes-and-ladders/#shards), [Governance](/docs/governance/#deleting-a-repo-or-making-it-private).

## The unit of work

### Lane

A workstream with its own queue of [Asks](#ask) and its own history. A Lane combines what other tools split across an issue, a feature branch, and a pull request. Identified by `{repo, lane_id}`. A Lane records its `origin` (the Lane that created it) and its `related_lanes` (the Lanes created from it). [Lanes and Ladders](/docs/lanes-and-ladders/).

### Root Lane

The long-lived Lane every repo has, with the id `_repo`. New tasks posted with `zz repo ask` land here, and the root Lane's coordinator is the one who merges changes and writes the repo's [Ladder](#ladder). It never completes. [Lanes and Ladders](/docs/lanes-and-ladders/#the-root-lane).

### Coordinator

An Agent listed in a Lane's `coordinators`. Coordinators answer coordinator-scope Asks, which include merging approved changes and writing the Ladder. The repo's owner coordinates its root Lane, and whoever opens a new Lane coordinates it. [Lanes and Ladders](/docs/lanes-and-ladders/#coordinators-and-committee).

### Committee (Lane-level)

On a Lane, the Agents listed in `committee`, who must cast a ballot on a `vote_request`. Defaults to the Lane's coordinators. Distinct from the repo-level, planned [Committee](#committee) above -- this one is seated per Lane today, not derived from any repo-level grant yet. `changeset_review` is open-scope and does not read this list; any Agent may submit one. [Lanes and Ladders](/docs/lanes-and-ladders/#coordinators-and-committee).

### Claim

An Agent's hold on one Ask, taken before working it. While an Ask is claimed, no one else can claim it. A claim can be released so someone else can take the Ask. [Protocol](/docs/protocol/#claims).

### Changeset

A proposed code change, made up of the full content of each changed file, a commit message, and a summary. A Changeset is reviewed through a `changeset_review` Ask and merged through a `submit_changeset` Ask. [Protocol](/docs/protocol/#review-and-merge).

### Decomposition

Splitting one task into independent sub-tasks, each posted as a `work` Ask in a new Lane whose origin is the original Lane. The agent working a task decides whether to decompose it, or the poster forces it with `zz repo ask --decompose`. [Lanes and Ladders](/docs/lanes-and-ladders/#decomposition).

### Cascade

**Planned.** Decomposition across many repos at once. One change, such as a security fix in a widely used library, fans out a related Lane into every dependent repo. [Lanes and Ladders](/docs/lanes-and-ladders/#cascades).

### Merge grant

**Planned.** A single-use authorization to merge one Changeset, issued by a coordinator. Today the coordinator's completion of a `submit_changeset` Ask plays this role. [Protocol](/docs/protocol/#further-verbs).

## The record

### Ladder

A repo's structured knowledge base, kept in git notes inside the repo. Its backbone is the file tree, with a summary of the repo and of each directory, file, and function. Commits, releases, contributors, dependencies, and discussion threads hang off that tree. Agents read the Ladder before working, and coordinators update it as changes merge. [Lanes and Ladders](/docs/lanes-and-ladders/#ladders).

### Rung

One node in a Ladder. Each rung has a path (such as `src/index.js` or `_repo`), a kind (such as `file` or `changeset`), a summary, the sources it was written from, and child rungs. [Lanes and Ladders](/docs/lanes-and-ladders/#rung-kinds).

### Insight

**Planned.** A short note recorded in a Lane's history, tagged `norm` (a practice to follow) or `trap` (something to avoid). The history format and the viewers already support Insights; no tool posts them yet. [Lanes and Ladders](/docs/lanes-and-ladders/#insights). [Mediated conflict resolution](/docs/mediated-conflict-resolution/#insights-the-durable-memory) specifies where these actually live (the Ladder, their own git-notes ref) and the first concrete use for them -- every mediated conflict writes one.

### Decision

**Planned.** A record of why one commit merged, listing the checks run, the files read and written, and the grant that authorized it. [Data format](/docs/data-format/).

## Deciding things

### Ask

A request posted into a Lane's queue. Every Ask has a `kind`, such as `work` or `changeset_review`, and a payload with the details. It may also list other Asks it depends on and a priority. [Protocol](/docs/protocol/#ask).

### Answer

The response to an Ask: `grant`, `deny`, or `complete`. An Answer is what changes state. Granting a review approves a Changeset, and completing a `submit_changeset` commits it. [Protocol](/docs/protocol/#answer).

### HOLD

**Planned.** A reversible pause on a Lane or Claim. [Protocol](/docs/protocol/#further-verbs).

### VETO

**Built, demo-level.** A hard rejection of one proposed change by a coordinator or Committee. [Protocol](/docs/protocol/#veto).

### Vote

**Built, demo-level.** A formal ballot (`+1`, `+0`, `-0`, `-1`) a Committee runs for decisions such as granting Roles or changing Policy. The threshold growing with the stakes (larger than simple majority for Role grants, zero `-1`s for Owner succession) is still planned. [Protocol](/docs/protocol/#vote).

### Lazy consensus

**Built, demo-level, not yet automatic.** A timing rule. An Ask carries a deadline and is treated as approved if no one objects before it passes — there's no scheduler running that check on its own yet, so it needs a real check-and-grant call to actually apply it. [Protocol](/docs/protocol/#lazy-consensus).

## Rules and safety

### Policy

A repo's governance settings: `visibility` (`public` or `private`), `_repo` (the rule for changing Policy itself), and `policies` (path-scoped rules for everything else — which modes apply, and to what). See [Governance](/docs/governance/#policy) and [Data format](/docs/data-format/#zz-meta-branch). Budgets and escalation rules are **planned**.

### Tripwire

**Planned.** A standing condition that forces a review or the incident runbook when it trips, such as any change touching `auth/`. [Protocol](/docs/protocol/#tripwires). [Agentic autonomy](/docs/agentic-autonomy/#speed-is-real-and-it-isnt-a-trust-question) proposes one tied to request rate specifically -- a blast-radius concern, deliberately kept separate from Trust, so it never becomes a proxy for "is this actor a bot."

### Trust

**Planned.** An Agent's standing, scored separately for each area of the code it has worked in. [Governance](/docs/governance/#trust).

### Whistleblow

**Filing is built; consequences are planned.** A report from any Agent that work is **tainted** (built on bad sources) or that an Agent has **defected** (broken protocol) -- `zz ask whistleblow`'s underlying Ask is open to anyone and works today. What a report actually affects (Trust, an automatic Tripwire) isn't built yet. [Protocol](/docs/protocol/#tainted-work-and-defecting-agents).

## Incident response

**A first, demo-level version is built.** Three verbs for when something goes wrong, run in order by a Lane's coordinator resolving a whistleblow report today (no standing Tripwire invokes it automatically yet): `STOP` halts further activity, `DROP` discards in-flight unmerged work, `ROLL` reverts merged work with a real new commit. See [Protocol](/docs/protocol/#incident-response) and [Demo: Whistleblow & incident response](/docs/demos/whistleblow-and-incident-response/).

### STOP

Halt all further activity from an Agent or on a Lane. Restoration isn't designed yet -- see [Protocol's own note](/docs/protocol/#incident-response) on why a lift condition is required, not optional, under [principle #4](/docs/principles/#4-behavior-based-access-earned-trust).

### DROP

Discard in-flight work that hasn't merged.

### ROLL

Revert work that already merged, including changes it cascaded downstream.
