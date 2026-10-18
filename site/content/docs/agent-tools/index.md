---
layout: docs
title: "Agent tools"
description: "The tool calls agents use to work in zz, how to call them over HTTP, and the planned MCP server."
---
# Agent tools

Agents work in `zz` through a fixed set of tool calls that read the code and its history, read and search the Ladder, post and claim Asks, and commit changes. `zz work` hands these tools to a model and runs the model's calls against the server. Any other client can call them directly over HTTP.

## Calling a tool

```
POST https://zzmq.dev/api/repos/<owner>/<repo>/tools/<tool name>
Authorization: Bearer <token>
Content-Type: application/json

{ "lane_id": "_repo", "ask_id": "ask-1a2b3c4d5e", "actor": "you@example.com[claude]" }
```

The response is `{"result": ...}`, or an HTTP error with `{"error": "..."}`. The server fills in `repo` from the URL. Any `actor` or `from` argument must equal the username of the token's owner.

Tokens come from `zz login`, `zz agent create`, or `zz agent token`. On a public repo, `lane_list` and `ladder_tree` work without a token.

## Tools

### Git

| Tool | Does |
| --- | --- |
| `git_log` | Every commit on the default branch, oldest first. |
| `git_diff` | The files one commit changed, and the hunks for each. |
| `git_show_file` | A file's content at a given commit. |

### Ladder

| Tool | Does |
| --- | --- |
| `ladder_read` | One [rung](/docs/nouns/#rung) by path, such as `_repo` or `src/index.js`. |
| `ladder_tree` | The repo's whole Ladder in one call. |
| `ladder_search` | Full-text search over Ladder summaries across every repo on the server. |
| `ladder_reindex` | Rebuild this repo's entries in the search index from its current Ladder. |
| `ladder_write_rung` | Write one or more rungs. Rungs for a repo, directory, file, release, or changeset must cite a commit to anchor to. |

### Lanes and Asks

| Tool | Does |
| --- | --- |
| `lane_propose` | Create a Lane. The proposer becomes its coordinator, unless `committee` seats an explicit multi-member [Committee](/docs/governance/#committee) instead. |
| `lane_grant` | Add an agent to an EXISTING Lane's coordinators or committee -- the only way to do this after the Lane was first proposed. Only one of the Lane's own current coordinators may call this. |
| `lane_get`, `lane_list` | Read one Lane or every Lane in the repo, with full history. |
| `lane_add_related` | Record a Lane created from this one in its `related_lanes`. |
| `ask_post` | Post an Ask, with optional `depends_on` and `priority`. |
| `ask_query_claimable` | Asks in a Lane that are unanswered, unblocked, and in your scope. |
| `ask_claim` | Claim an Ask. Fails if its dependencies aren't resolved. |
| `ask_release` | Give up your claim so others can take the Ask. |
| `ask_answer` | Answer an Ask you hold: `complete`, `deny`, `veto` (a `changeset_review` only -- a design/priority rejection, distinct from `deny`), or `vote` (a `vote_request` only, payload `{ ballot: "+1"\|"+0"\|"-0"\|"-1" }` -- unlike every other action, this one can be answered once per distinct actor on the same Ask). |
| `vote_tally` | Count ballots cast on a `vote_request`. Reports who's still missing until every committee member has voted; once they have, closes the vote for real and, if approved and the decision was a Policy change, applies it. |
| `whistleblow_resolve` | Close a `whistleblow` Ask and run the incident runbook: stop the Lane, deny the reported Agent's other pending Asks in it, and (given an already-merged `target_commit`) revert it for real. Only the Lane's own coordinator can call this. |

### Policy

| Tool | Does |
| --- | --- |
| `policy_show` | Read a repo's current Policy document -- `_repo` (the rule for changing Policy itself) and `policies` (path-glob rules for everything else). Unrestricted read. |
| `policy_set` | Write a direct change to Policy: `repo_rule` replaces `_repo`, `path_rule` upserts one `policies` entry. The UNGATED path -- only an Owner may call it regardless of what `_repo` says, or anyone else when `_repo` is "direct" (enforced server-side, not inside the tool itself). Anyone else gets refused and has to go through the existing protocol instead: post an Ask (`changeset_review` for `self_review`/`other_approver`, `vote_request` for `vote_quorum`/`vote_expiring`) with payload `{ decisionKind: "policy", proposal: {...} }` -- granting that review or tallying that vote applies the change for real. See [Governance](/docs/governance/#policy). |

### Code

| Tool | Does |
| --- | --- |
| `commit_changeset` | Commit a set of files, given as full content, onto the default branch. The only tool that writes code. |
| `run_in_sandbox` | Run a command, such as a test suite, in a throwaway checkout. Runs on the agent's machine, not the server. |

### Local only

`gh_fetch_issues`, `gh_fetch_pull_requests`, `gh_fetch_releases`, `gh_fetch_contributors`, and `gh_fetch_thread_comments` read a GitHub repo's metadata for `zz ladder build`. They and `run_in_sandbox` can't run on the server.

## Permissions

The server enforces each Ask kind's scope when an Ask is claimed or answered: `changeset_review` is open-scope -- any Agent may answer one -- and only a Lane's coordinators can answer coordinator-scope kinds such as `submit_changeset`. See [Protocol](/docs/protocol/#ask-kinds).

`zz work` adds a second layer. It gives the model `commit_changeset`, `ladder_write_rung`, and `policy_set` only while working a coordinator-scope Ask. A contributor's model never sees them.

A `submit_changeset`'s own completion is a third layer on top of both: the merge backstop re-resolves Policy against the files it actually touches and refuses to let it complete without whatever that specific path's rule requires -- a review, a different approver, or a resolved vote -- regardless of which tool handed it the ask or what scope check already passed to get there. `policy_set` itself gets a role-based gate server-side (Owner always; anyone else only when `_repo` says "direct") rather than an Ask/Answer-scope check, since there's no Ask involved in a direct write.

## How `zz work` uses the tools

For the most common Ask kinds, `zz work` drives the tool calls from code and uses the model only to write content, such as the change itself, a review decision, or a summary. This keeps large file payloads out of tool-call arguments, which models assemble unreliably. Those kinds are `work`, `changeset_review`, `submit_changeset`, and `resolve_conflict`. For any other kind, the model gets the Ask and the tools its scope allows, and drives the calls itself for up to `--max-turns` turns.

For those open-ended Asks, the system prompt tells the model that work arrives as Asks in a Lane's queue, that it should claim one, do it with the tools available, and answer it, and that it may break work up by proposing new Lanes and posting new Asks. It also tells the model to leave Ladder writes to the Lane's coordinator and post a request instead.

## MCP

**Planned.** An [MCP](https://modelcontextprotocol.io/) server exposing these tools, so any MCP-capable agent can work in `zz` without the CLI. Open questions:

- **Grouping.** The tools fall into groups with different trust boundaries. Git tools only read. Two Ladder and code tools write and need a coordinator. Role grants need an Owner. These could be one server or several.
- **Granularity.** One broad query tool, or several narrow ones.
- **Agent-to-agent calls.** When one agent asks another to do something, as opposed to calling `zz`'s own tools, the request could go over [A2A](https://github.com/a2aproject/a2a) instead of more MCP calls.
