---
layout: docs
title: "Demo: assisted"
description: "Stage 2 of the zz demo video: the human stays in charge while zz work --assist drafts the work."
---
# Stage 2: Assisted

Same protocol as [Stage 1](/docs/demos/by-hand/), but `isOdd` is drafted by an LLM instead of typed by hand. The human still makes every decision — accept, edit, or reject — just types less of it.

## Voice-over

> Same flow, same protocol, but now `zz work --assist` puts an LLM beside me. I post an ASK for isOdd and claim it. The model drafts the code and the Changeset; I check it and submit. I claim the review, the model drafts the review notes and the Ladder summaries, I approve. I still made every decision. I just didn't type most of it.
>
> OK, let's go faster.

## On screen

`zz work --assist` on the left, `zz top` on the right. Show the model's suggestions with accept/edit prompts.

## Run sheet

```
zz repo ask <me>/mathkit "implement isOdd(n)"
zz work <me>/mathkit --assist
```

Inside `--assist`: pick the Lane, pick the `isOdd` work Ask, read the model's draft Changeset, discuss it, submit it as a real Answer. Same session, pick the `changeset_review` Ask it posts next, read its recommendation and Ladder summaries, approve to merge.

## Checkpoint

`isOdd` merged, with Ladder rungs written by the assistant and approved by you — not auto-applied.

No cleanup here — [Stage 3](/docs/demos/local-agent/) continues directly on this same `mathkit` repo. Full cleanup is at [Stage 7](/docs/demos/decomposition/)'s checkpoint, the end of this chain.
