---
layout: docs
title: "Data format"
description: "Where zz stores repos, Ladders, repo settings, Lane state, and accounts, and the shape of each."
---
# Data format

`zz` keeps data in five places:

| Where | What | Travels with `git clone`? |
| --- | --- | --- |
| The repo's default branch | Code and its history | Yes |
| Git notes in the repo | The [Ladder](/docs/nouns/#ladder) | With `git clone --mirror`, or by fetching `refs/notes/*` |
| The repo's `zz-meta` branch | Description, Policy, owner, Role grants | Yes |
| A Durable Object per repo | [Lane](/docs/nouns/#lane), Ask, and Answer state | No |
| Cloudflare D1 | Accounts, tokens, the repo index, the search index | No |

The design goal is that the repo carries everything that matters, so a repo can leave the platform with its history, knowledge, and settings intact. Code, the Ladder, and repo settings meet that goal today. Lane history does not yet. See [Architecture](/docs/architecture/#portability).

## Ladder

The Ladder is stored as [git notes](https://git-scm.com/docs/git-notes) under `refs/notes/zz/ladder/`:

| Ref | Attached to | Holds |
| --- | --- | --- |
| `refs/notes/zz/ladder/code` | The blob, tree, or root tree a rung describes | `repo`, `directory`, `file` rungs and everything nested under them |
| `refs/notes/zz/ladder/changeset` | The commit a rung describes | `changeset` rungs with their `filechange` and `linechange` children |

Each note is JSON holding one rung and its embedded children:

```json
{
  "path": "hello.js",
  "kind": "file",
  "summary": "Exports greet(name), which returns a greeting string for the given name.",
  "sources": [
    { "kind": "commit", "ref": "3f9a2c1e...", "title": "Add greet()", "author": "you@example.com[claude]", "at": "2026-10-13T18:22:04Z" }
  ],
  "children": []
}
```

A child can also be a reference to another note, `{"ref": "..."}`, instead of an embedded rung. Ladders built locally with `zz ladder build` add more refs for releases, discussion threads, contributors, and dependencies, which hang off the repo's root commit.

Standard git tools can read the Ladder:

```
git fetch origin 'refs/notes/*:refs/notes/*'
git notes --ref=zz/ladder/changeset show <commit>
```

## `zz-meta` branch

Repo settings live on an orphan branch named `zz-meta`, separate from the code's history so that settings changes don't add commits to it. Clone it with `git clone -b zz-meta <url>`. It holds two files.

### `meta.json`

```json
{
  "description": "A place to try zz",
  "policy": { "visibility": "public", "_repo": { "mode": "vote_quorum" }, "policies": [{ "path": "**", "mode": "self_review" }] },
  "owner": "you@example.com",
  "shard_of": "you@example.com/hello",
  "created_at": "2026-10-13T18:00:00Z"
}
```

`shard_of` appears only on a [shard](/docs/nouns/#shard) and names its immediate parent. `visibility` is `public` or `private`. A public repo can be read by anyone and written only by Maintainers and above. `policy._repo`/`policies` are [Policy](/docs/governance/#policy)'s own approval rules — `_repo` governs changing Policy itself, `policies` is path-scoped rules for everything else, shown here at a new repo's own defaults.

### `roles.json`

```json
{
  "grants": [
    { "principal": "you@example.com", "role": "owner", "granted_by": "system", "at": "2026-10-13T18:00:00Z" },
    { "principal": "you@example.com[claude]", "role": "contributor", "granted_by": "you@example.com", "at": "2026-10-13T18:05:00Z" }
  ]
}
```

A principal is an Agent's username. Roles are `owner`, `maintainer`, `contributor`, and `viewer`. An Agent with no grant on a public repo is treated as a viewer. See [Governance](/docs/governance/#role).

## Lanes

Each repo has one Durable Object holding its Lanes in SQLite, one row per Lane with the Lane stored as JSON:

```json
{
  "id": "_repo",
  "repo": "repo-3c9e1a7b",
  "origin": null,
  "name": "you@example.com/hello",
  "objective": "the you@example.com/hello repository",
  "status": "active",
  "scope": ["**"],
  "trigger": { "kind": "manual", "proposed_by": "you@example.com" },
  "coordinators": ["you@example.com"],
  "maintainers": ["you@example.com"],
  "history": [
    { "id": "ask-1a2b3c4d5e", "type": "ASK", "kind": "work", "from": "you@example.com",
      "payload": { "description": "Add hello.js exporting a greet(name) function" }, "at": "2026-10-13T18:10:00Z" },
    { "id": "ask-5e6f7a8b9c", "type": "ASK", "kind": "claim_request", "from": "you@example.com[claude]",
      "payload": { "target": "ask-1a2b3c4d5e" }, "at": "2026-10-13T18:11:00Z" },
    { "id": "answer-0d1e2f3a4b", "type": "ANSWER", "ask": "ask-5e6f7a8b9c", "from": "you@example.com",
      "action": "grant", "payload": { "grant": "grant-ask-5e6f7a8b9c" }, "at": "2026-10-13T18:11:00Z" }
  ],
  "related_lanes": []
}
```

History entries are one of:

| `type` | Fields |
| --- | --- |
| `ASK` | `id`, `kind`, `from`, `payload`, `depends_on`, `priority`, `at` |
| `ANSWER` | `id`, `ask` (the Ask's id), `from`, `action` (`grant`, `deny`, `complete`), `payload`, `at` |
| `INSIGHT` | `kind` (`norm` or `trap`), `text`, `from`, `at` |

`repo` holds the server's internal storage name for the repo. A `related_lanes` entry is `{repo, lane, origin, status}`, where `origin` is `{repo, lane}`.

**Planned.** Exporting Lane state into the repo, likely onto the `zz-meta` branch, so a clone carries its coordination history too.

## Accounts and the index

D1 holds what belongs to no single repo:

- **Agents and identities.** One row per Agent, human or managed, keyed by username, plus which login provider (Cloudflare or Google) each human signed in with.
- **Tokens and sessions.** Hashed bearer tokens, web sessions, and pending `zz login` handshakes.
- **The repo index.** Every repo's slug, owner, description, visibility, shard parent, and a cache of its Role grants, for search and listing. The `zz-meta` branch is the source of truth for anything cached here.
- **Tracking.** The repos each Agent has chosen to watch.
- **The Ladder search index.** A full-text index of rung summaries across all repos, which `ladder_search` and the explore page query. It can be rebuilt from the Ladders with `ladder_reindex`.

## Local mode

With `--local`, `zz` keeps everything on your machine:

| Path | Contents |
| --- | --- |
| `~/.zz/repos/<owner>/<repo>/` | A git clone. Its Ladder lives in the clone's git notes. |
| `~/.zz/state/<owner>/<repo>/.zz/zz.db` | Lane state in SQLite, in the format shown above. |

Shard names keep their brackets everywhere except on disk, where `repo[task]` becomes `repo__task`.

The original design for a committed `.zz/` directory with decision records, votes, trust scores, and a fuller `policy.yaml` is in the [Archive](/docs/archive/data-format-design/).
