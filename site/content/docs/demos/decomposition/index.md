---
layout: docs
title: "Demo: decomposition"
description: "Stage 7 of the zz demo video: one Ask splits into thirty related Lanes, worked in parallel by the existing fleet, merging back up to the root."
---
# Stage 7: Decomposition

The last stage. One Ask — add thirty functions — splits itself into thirty independent sub-Asks, each its own [Lane](/docs/nouns/#lane), recorded on the parent Lane's `related_lanes`. The same fleet from [Stage 6](/docs/demos/bulk-asks/) works them in parallel, and everything merges back up to the root.

## Voice-over

> Last one. A single ASK: add these thirty functions, and break the work into separate ASKs. One agent claims it and decomposes it into thirty related Lanes, each its own work offer. The fleet takes them in parallel. Lanes merge into Lanes, all the way up to the root.
>
> And because every step wrote to the Ladder, here's the whole story, from "mathkit is a numeric utility library" down to why gcd handles negative numbers, with a link to the exact commit. Same data on the web at zzmq.dev, stored as git in Cloudflare Artifacts.
>
> One function by hand took __ minutes. Thirty took __.

## On screen

`zz top` full screen as one Lane splits into thirty related Lanes. Then the Ladder tab: climb from the repo rung down to one function. Cut to zzmq.dev showing the same repo, Ladder, and commit log.

## Run sheet

```
zz repo ask <me>/mathkit --decompose "Add these 30 functions, with tests: <list>"
```

Without `--decompose` the claiming agent decides for itself whether to split the work; the flag forces it, for a deterministic take. The function list (none overlapping Stage 6):

```
abs, sign, product, square, cube, isInteger, isPositive, isNegative,
primeFactors, mode, range, variance, stdDev, lerp, inverseLerp, remap,
floorTo, ceilTo, inRange, degToRad, radToDeg, hypot, distance, percent,
sumOfSquares, cumulativeSum, digitSum, isPowerOfTwo, nextPowerOfTwo,
isMultipleOf
```

Watch one agent claim the parent Ask and propose thirty sibling Lanes, each with its own `work` Ask, recorded as the parent's related Lanes. The fleet from Stage 6 works them in parallel. In `zz top`'s Ladder tab, climb repo rung → file → `gcd` → its commit. Cut to zzmq.dev: same repo, Ladder, commit log, shards.

## Checkpoint

Forty-five functions merged in total (ten from Stage 6, thirty here, plus the five from Stages 1–5). One root Lane with thirty related Lanes, all merged.

Clean up when done — this is the end of the chain Stages 1–7 all share, so one pass clears everything:

```
zz repo delete <me>/mathkit
zz agent delete <me>[maint] && zz agent delete <me>[dev1] && zz agent delete <me>[dev2] && zz agent delete <me>[dev3]
```
