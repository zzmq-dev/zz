---
layout: docs
title: "Demo: two roles"
description: "Stage 5 of the zz demo video: a contributor worker that can't merge and a coordinator worker that can, separated for real."
---
# Stage 5: Two roles

The shape the earlier stages were building toward: a contributor worker that can write code but holds no merge authority, and a coordinator worker that holds the maintainer [Role](/docs/governance/#role) but only ever answers review and merge Asks. `min` goes through a real fork.

## Voice-over

> Now the real shape. A contributor worker that can write code but can't merge, and a coordinator worker that can merge but only answers review and merge ASKs. I post: implement min. The contributor claims it, forks mathkit, opens a Lane, and does the work in its fork. When it's done it ASKs the origin repo to merge. The coordinator picks up the Changeset, reviews it, merges it, updates the Ladder, and closes out the original ASK. Two agents, one protocol, nobody waiting on me.
>
> OK, let's go faster.

## On screen

A 2×2 grid: top-left `zz top`, top-right the coordinator's `zz work`, bottom-left the contributor's `zz work`, bottom-right a shell for posting Asks. Highlight each pane as it acts.

## Run sheet

```
zz agent create dev1
zz repo grant @me/mathkit "@me[dev1]" contributor
```

Top-right (coordinator):
```
zz work @me/mathkit --as maint --scope maintainer --provider groq
```

**Correction -- `--scope coordinator` is too narrow for this.** It only includes Asks whose scope is literally `coordinator` (`submit_changeset`, the merge step) -- `changeset_review` is scope `maintainer`, a separate category, so a worker started with `--scope coordinator` never claims it at all, no matter what Lane authority it holds. `--scope maintainer` includes both `maintainer`- and `coordinator`-scope Asks (review and merge) while still excluding `open`-scope `work` Asks -- exactly "do everything the maintainer worker should, never the contributor's job."

Bottom-left (contributor):
```
zz work @me/mathkit --as dev1 --scope contributor --provider groq
```

Bottom-right:
```
zz repo ask @me/mathkit "implement min(...numbers)"
```

Narrate as it happens: claim → fork into a shard → open a Lane in the shard → `submit_changeset` Ask back to the origin → coordinator reviews → merges → Ladder updated → original Ask closed. `ctrl+/` inside the TUI drops into the shard's own shell if you want to show the fork on disk.

## Checkpoint

`min` merged through a real fork; the shard shows up as its own repo under `<dev1-identity>/mathkit[...]`.

No cleanup here — [Stage 6](/docs/demos/bulk-asks/) continues directly on this same `mathkit` repo and the `maint`/`dev1` workers. Full cleanup is at [Stage 7](/docs/demos/decomposition/)'s checkpoint, the end of this chain (deleting `dev1` there also removes its shard).
