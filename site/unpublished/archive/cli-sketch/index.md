---
layout: docs
title: "CLI sketch"
description: "The original design sketch of the zz command line, written before the CLI existed."
---
# CLI sketch

> **Archived.** This is a design or planning document from earlier in the project. It records the reasoning at the time it was written and may describe plans that changed or were never built. See the [Archive](/docs/archive/) index for context, or the [Overview](/docs/overview/) for how `zz` works today.

This is a starting point. Commands and flags here will change once there's a real Maintainer to drive them against. `zz` wraps git/Artifacts for content operations and adds the coordination protocol on top; it does not reimplement git.

## Ladder and Lane (implemented)

The one part of this page with working code behind it today. Onboarding drives the same Lane/ASK/ANSWER engine a live Maintainer uses, not a script writing straight into storage; a local model (configurable, currently an Ollama backend) does the content analysis.

```
zz ladder build <owner/repo> [--force]
zz ladder replay-commits <owner/repo> [--limit <n>] [--force]
zz ladder dump <owner/repo> [--format text|json|html] [--out <path>]
zz lane log <owner/repo> [--lane <id>] [--format text|json] [--out <path>]
```

`build` describes the file tree at HEAD and onboards issues, PRs, releases, and contributors, each as its own Lane that claims, does the work, and merges its result into the repo's Ladder. It skips anything that already has a note — running it again, or against a repo that already has hand-researched content layered on top, never overwrites what's there — `--force` rebuilds the file tree anyway.

`replay-commits` walks the commit log from the root commit forward, one Lane per commit, building a `changeset` rung with nested `filechange` and `linechange` children from that commit's diff. Each file touched also gets a separate, non-blocking request to update its current-state `file` rung (what it looked like before this commit, what it looks like now) — the repo's own long-lived Lane is the coordinator for those. `--limit` bounds how many not-yet-onboarded commits to replay in one run.

`dump` materializes the resulting Ladder for reading, without touching the notes: plain text, JSON, or a self-contained HTML page.

`lane log` shows the protocol trail itself — every ASK/ANSWER across every Lane, in order — which is what produced the Ladder `dump` shows the result of.

## Content operations (thin wrappers over Artifacts/git)

```
zz clone <repo>
zz fork <repo>
zz push
zz pull
```

Behave as their git equivalents; `fork` additionally registers the fork with the upstream Maintainer so it participates in OCC and shows up in `zz top`.

## Lane lifecycle

```
zz lane propose "<name>" [--scope <paths>] [--budget <n>] [--broadcast <scope>]
zz lane list [--open|--active|--held]
zz lane show <lane> --ladder                                  # the Lane's tree + summary

zz ask <lane> --claim                                         # kind: claim_request
zz ask <lane> --review <changeset>                             # kind: review_request
zz ask <lane> --merge <changeset>                               # kind: merge_request, Coordinator-only to grant
zz ask <lane> --more-coordinators [--role committer+]           # kind: coordinator_request
zz ask <lane> "<question>"                                      # kind: change_request / navigation query
zz answer <ask-id> --grant | --deny | "<response>"
zz hold <lane> ["<reason>"]
zz veto <ask-id> ["<reason>"]                                    # Coordinator/Committee only
```

## Roles and votes

```
zz role grant <agent> <role> --repo <repo> [--scope <paths>]
zz role revoke <agent> <role> --repo <repo>
zz role list --repo <repo>

zz vote call "<subject>" --threshold lazy_majority|two_thirds|consensus
zz vote cast <vote-id> +1|+0|-0|-1
zz vote show <vote-id>
```

## Incident response

```
zz stop <lane|agent>
zz drop <lane>
zz roll <lane|commit>
```

Each logs a runbook entry to `.zz/` regardless of whether it was invoked manually or by a Tripwire.

## Observability

`zz top` and `zz ps` are operational views over the protocol: a live (`top`) or point-in-time (`ps`) table of every Lane's state, Coordinator, the Coordinator's trust in that area, age, and last `ASK`.

```
zz top                 # live view of all Lanes
zz ps                  # point-in-time snapshot, scriptable
zz log <lane>           # the Lane's full ASK/ANSWER/HOLD/VETO/merge history
zz show <lane> --ladder # the Lane's current summary, with links down to source commits
zz insight <lane> --norm|--trap "<note>"   # capture an in-the-flow insight
```

## Governance and policy

```
zz tripwire add <scope> --when "<condition>" --then "<runbook step>"
zz tripwire list
zz trust <agent> [--topic <scope>]   # trust lookup, per topic
zz whistleblow <agent|lane> "<report>"
```

## Example session

```
$ zz lane propose "add OAuth provider support" --scope packages/auth
  → opened lane: auth-oauth (backlog)

$ zz ask auth-oauth --claim
  → claimed by you, lease 4h

$ zz top
  LANE          AGENT        STATE     TRUST     AGE     LAST ASK
  auth-oauth    you          active    0.82      1m      claim granted

$ zz ask auth-oauth --review cs-001
  → review_request sent, policy requires 1 reviewer

$ zz answer ask-002 --grant   # a reviewer approves cs-001

$ zz ask auth-oauth --merge cs-001
  → merge_request sent to coordinator

$ zz answer ask-003 --grant   # coordinator issues the merge grant

$ zz push
  → merge grant valid, OCC check clean, merged
```
