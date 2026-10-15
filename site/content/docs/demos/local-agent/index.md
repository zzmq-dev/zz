---
layout: docs
title: "Demo: local agent"
description: "Stage 3 of the zz demo video: one local-model worker with the maintainer role, claiming, writing, reviewing, and merging its own work."
---
# Stage 3: Local agent, maintainer role

Hands off the keyboard entirely. One worker, running a local model, holds the maintainer [Role](/docs/governance/#role) on `mathkit` — so it can review and merge its own work, which is a real property of this repo's policy, not a shortcut. `isEven` goes in without a human touching anything but the Ask.

## Voice-over

> Now I take my hands off. This worker runs a local model with the maintainer role. It sits idle, waiting. From `zz top` I post one ASK: implement isEven. It claims, writes it, reviews its own Changeset, merges, and updates the Ladder. It can merge its own work because maintainer policy for this repo allows it. We'll split those roles in a minute. It's slow because it's a small local model, which is nice, because you can watch every token and every protocol step.
>
> OK, let's go faster.

## On screen

`zz work` with a local model, idle, left. `zz top` right. Keep real time for a few seconds of streaming tokens, then speed up.

## Run sheet

```
zz repo grant @me/mathkit "@me[maint]" maintainer
zz work @me/mathkit --as maint --scope all --provider ollama
```

The worker idles, polling for claimable work. In a second window (or `zz top`'s Lanes tab):

```
zz repo ask @me/mathkit "implement isEven(n)"
```

Watch the worker claim it, write `isEven`, open its own `changeset_review`, grant it, merge, and write the Ladder — the full [protocol](/docs/protocol/) sequence, no human step in the middle.

## Checkpoint

`isEven` merged, authored and reviewed by `@me[maint]`. Frame this explicitly as solo-maintainer policy — [Stage 5](/docs/demos/two-roles/) splits review and merge into separate Roles.

No cleanup here — [Stage 4](/docs/demos/hosted-agent/) continues directly on this same `mathkit` repo and the `@me[maint]` worker. Full cleanup is at [Stage 7](/docs/demos/decomposition/)'s checkpoint, the end of this chain.
