---
layout: docs
title: "Demo: by hand"
description: "Stage 1 of the zz demo video: the whole protocol, done with CLI commands and no agent at all."
---
# Stage 1: By hand

One function, `sum`, implemented with no agent at all — every step of the protocol done by hand from the CLI, so each noun (Repo, [Ask](/docs/nouns/#ask), [Lane](/docs/nouns/#lane), [Changeset](/docs/nouns/#changeset), [Ladder](/docs/nouns/#ladder)) gets introduced as it's used.

## Voice-over

> Here's everything zz asks of a contributor, done by hand. I create a repo, mathkit. I post an ASK: implement sum. An ASK is a request anyone can answer, human or agent. I claim it, which opens a Lane, my workstream. I clone, write sum, commit, and package that as a Changeset. Submitting it is another ASK, this time for review. A maintainer approves it — that's a real decision, recorded — and then a coordinator actually merges it: a separate, mechanical step, today still run through `zz work` rather than a bare CLI command. Last, I write the Ladder: summaries of what changed and why. That's the knowledge an agent climbs later instead of digging through old threads.
>
> That's a lot of work for one function. OK, let's go faster.

## On screen

One terminal full screen, `zz top` small in a corner. Sped up 4–8x with a caption naming each command. Slow to real time on the Ask, the submit, and the Ladder rung.

## Run sheet

Verified live against `zzmq.dev`, 2026-10-14. Two corrections from the original script, both real, both worth narrating rather than hiding:

```
zz repo create mathkit --description "Small, dependency-free math utilities"
zz repo ask <me>/mathkit "implement sum(...numbers)"
zz repo asks <me>/mathkit                             # find the ask id
zz ask claim <me>/mathkit <ask-id>
zz repo clone <me>/mathkit && cd mathkit
```

Write `index.js`:

```js
export function sum(...numbers) {
  return numbers.reduce((total, n) => total + n, 0);
}
```

```
git add -A && git commit -m "Add sum"
zz repo submit <me>/mathkit <lane-id> <ask-id> --message "Add sum"
```

**Correction 1 — `zz review` approves; it does not merge.** `zz repo submit`'s own output names the changeset_review's ask id -- `--ask <id>` reviews just that one and exits, instead of the default wait loop meant for a Maintainer sitting at a terminal watching for whatever comes next:

```
zz review <me>/mathkit --ask <changeset-review-ask-id>
# approve (a) / request changes (r) / skip (s)? a
```

The changeset_review is now granted — but nothing is committed yet. The actual merge needs a coordinator's `zz work` process to pick up the resulting `submit_changeset` Ask and call `commit_changeset` for real (mechanical here — no real judgment call for the model to make, but it is a model turn):

```
zz work <me>/mathkit --scope coordinator --provider groq --stdio
# ... claims the submit_changeset, commits, ctrl+c once it logs "complete" ...
```

Confirmed merged: `git log` in a fresh clone shows the real commit.

**Correction 2 — a function-level rung can't be written with `zz ladder edit`.** Only `repo`, `directory`, `file`, `release`, `changeset`, `ask`, `contributor`, and `dependencies` have a git object of their own to anchor to; `function` (and `lines`/`filechange`/`linechange`) only exist nested inside one of those rungs' `children`, which this command always writes as `[]`. Narrate the file and repo rungs; skip the function-level claim, or show it being written by an agent's own `ladder_write_rung` tool call in a later stage instead:

```
zz ladder edit <me>/mathkit index.js --kind file --summary "Numeric utility functions."
zz ladder edit <me>/mathkit _repo --kind repo --summary "mathkit: small, dependency-free math utilities."
zz lane log <me>/mathkit
```

## Checkpoint

`mathkit` has `sum`, one merged Lane with a real commit, and repo/file Ladder rungs. `zz lane log` shows the full trail: the work Ask, its claim, the changeset_review and submit_changeset pair, the grant, and the final commit.

No cleanup here — [Stage 2](/docs/demos/assisted/) continues directly on this same `mathkit` repo. Full cleanup is at [Stage 7](/docs/demos/decomposition/)'s checkpoint, the end of this chain.
