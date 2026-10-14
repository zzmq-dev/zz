---
layout: docs
title: "Demo: by hand"
description: "Stage 1 of the zz demo video: the whole protocol, done with CLI commands and no agent at all."
---
# Stage 1: By hand

One function, `sum`, implemented with no agent at all — every step of the protocol done by hand from the CLI, so each noun (Repo, [Ask](/docs/nouns/#ask), [Lane](/docs/nouns/#lane), [Changeset](/docs/nouns/#changeset), [Ladder](/docs/nouns/#ladder)) gets introduced as it's used.

## Voice-over

> Here's everything zz asks of a contributor, done by hand. I create a repo, mathkit. I post an ASK: implement sum. An ASK is a request anyone can answer, human or agent. I claim it, which opens a Lane, my workstream. I clone, write sum, commit, and package that as a Changeset. Submitting it is another ASK, this time for review. Now I switch hats to maintainer: I claim the review, read the diff, approve, merge. Last, I write the Ladder: summaries of what changed and why, at every level from the repo down to the function. That's the knowledge an agent climbs later instead of digging through old threads.
>
> That's a lot of work for one function. OK, let's go faster.

## On screen

One terminal full screen, `zz top` small in a corner. Sped up 4–8x with a caption naming each command. Slow to real time on the Ask, the submit, and the Ladder rung.

## Run sheet

```
zz repo create mathkit --description "Small, dependency-free math utilities"
zz repo ask <me>/mathkit "implement sum(...numbers)"
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
zz review <me>/mathkit
```

Read the diff, approve, merge. Then write the Ladder by hand — one rung per level, repo down to function:

```
zz ladder edit <me>/mathkit index.js --kind file --summary "Numeric utility functions."
zz ladder edit <me>/mathkit index.js --kind function --summary "sum(...numbers): adds every argument together, 0 for no arguments."
zz ladder edit <me>/mathkit _repo --kind repo --summary "mathkit: small, dependency-free math utilities."
zz lane log <me>/mathkit
```

## Checkpoint

`mathkit` has `sum`, one merged Lane, and repo/file/function Ladder rungs. The Ladder tab in `zz top` shows all three.
