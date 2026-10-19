---
layout: docs
title: "Demo: hosted agent"
description: "Stage 4 of the zz demo video: the same worker on Groq instead of a local model — speed as a dial, not a different protocol."
---
# Stage 4: Hosted agent

Same worker, same Ask shape as [Stage 3](/docs/demos/local-agent/), restarted against Groq instead of a local model. Nothing about the protocol changes — only how fast the tokens come back.

## Voice-over

> Same worker, same ASK shape, a fast hosted model on Groq.
>
> [let it run, about 5 seconds]
>
> Done. OK, let's go faster.

## On screen

Same layout as Stage 3, worker restarted. Real time, no speed-up — let the speed speak for itself.

## Run sheet

```
# stop the Stage 3 worker, then:
zz work @me/mathkit --as maint --scope all --provider groq
zz ask post @me/mathkit --remote --description "implement max(...numbers)"
```

## Checkpoint

`max` merged in seconds, same `@me[maint]` identity, same Role, same protocol trail in `zz lane log`. The model and the backend are independent dials — say so on camera.

No cleanup here — [Stage 5](/docs/demos/two-roles/) continues directly on this same `mathkit` repo. Full cleanup is at [Stage 7](/docs/demos/decomposition/)'s checkpoint, the end of this chain.
