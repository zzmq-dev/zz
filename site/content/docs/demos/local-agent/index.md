---
layout: docs
title: "Demo: local agent"
description: "Stage 3 of the zz demo video: one local-model worker with the Coordinator role, claiming, writing, reviewing, and merging its own work."
---
# Stage 3: Local agent, Coordinator role

Hands off the keyboard entirely. One worker, running a local model, holds the Coordinator [Role](/docs/governance/#role) on `mathkit` and this Lane's own coordinator authority — so it can review and merge its own work, which is a real property of this repo's policy, not a shortcut. `isEven` goes in without a human touching anything but the Ask.

## Voice-over

> Now I take my hands off. This worker runs a local model with the Coordinator role. It sits idle, waiting. From `zz top` I post one ASK: implement isEven. It claims, writes it, reviews its own Changeset, merges, and updates the Ladder. It can merge its own work because self-review policy for this repo allows it. We'll split those roles in a minute. It's slow because it's a small local model, which is nice, because you can watch every token and every protocol step.
>
> OK, let's go faster.

## On screen

`zz work` with a local model, idle, left. `zz top` right. Keep real time for a few seconds of streaming tokens, then speed up.

## Run sheet

```
zz agent create maint
zz repo grant @me/mathkit "@me[maint]" coordinator
zz lane grant @me/mathkit _repo "@me[maint]" coordinator
zz work @me/mathkit --as maint --scope all --provider ollama
```

**Correction — a repo Role alone isn't enough; `zz work` gives no error about it either.** `zz repo grant` sets `maint`'s Role on the repo, which gates a direct `git push` -- and, separately, is also what the server checks before letting `commit_changeset`/`ladder_write_rung` run at all (`COORDINATOR_ONLY_REMOTE_TOOLS` in `worker/src/webApp.ts`, Coordinator+ required, regardless of any Lane authority): skip this grant entirely and the worker fails immediately trying to write its own Ladder rung, with a plain "is not a Coordinator" error. Claiming the `changeset_review` needs nothing extra -- it's open-scope, any agent may submit one. Claiming the `submit_changeset` that actually merges needs being one of this specific Lane's own `coordinators` -- checked by `engine/lane.ts`'s own `answer()`, not derived from the repo Role at all (tying the two together is planned, not built yet). Skip `zz lane grant` (with the repo Role already granted) and the worker claims and writes `isEven` fine, reviews it fine, then just sits there forever once it posts its own `submit_changeset` -- not stuck, not erroring, just correctly excluded from the merge step on a Lane it was never actually added to as a coordinator. `_repo` starts with only the repo's owner in `coordinators`; every other Lane in these demos starts the same way. Both grants are genuinely required for a delegated agent; running as yourself (no `--as`) needs neither, since you're already Owner on the repo (which outranks Coordinator) and become any Lane's native coordinator just by being first to touch it.

The worker idles, polling for claimable work. In a second window (or `zz top`'s Lanes tab):

```
zz repo ask @me/mathkit "implement isEven(n)"
```

Watch the worker claim it, write `isEven`, open its own `changeset_review`, grant it, merge, and write the Ladder — the full [protocol](/docs/protocol/) sequence, no human step in the middle.

## Checkpoint

`isEven` merged, authored and reviewed by `@me[maint]`. Frame this explicitly as solo-Coordinator, self-review policy — [Stage 5](/docs/demos/two-roles/) splits review and merge into separate Roles.

No cleanup here — [Stage 4](/docs/demos/hosted-agent/) continues directly on this same `mathkit` repo and the `@me[maint]` worker. Full cleanup is at [Stage 7](/docs/demos/decomposition/)'s checkpoint, the end of this chain.
