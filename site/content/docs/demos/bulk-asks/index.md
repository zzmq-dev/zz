---
layout: docs
title: "Demo: bulk Asks"
description: "Stage 6 of the zz demo video: ten Asks posted at once, claimed by three contributor workers with no central dispatcher."
---
# Stage 6: Three workers, ten Asks

Two more contributor workers join [Stage 5](/docs/demos/two-roles/)'s `dev1`. Ten Asks go in at once; there's no scheduler assigning them — each worker claims what it can, and a claim is a lease, so nobody duplicates effort.

## Voice-over

> Two more contributors. Ten ASKs, all at once. Watch them spread out. There's no scheduler assigning work; each worker claims what it can, and a claim is a lease, so nobody duplicates effort. Changesets that touch different code merge in parallel instead of queueing.
>
> OK, let's go faster.

## On screen

Add two more contributor windows, or collapse all three workers to small tiles and give `zz top` the big pane. Fire all ten Asks from one command.

## Run sheet

```
zz repo grant <me>/mathkit <me>[dev2] contributor
zz repo grant <me>/mathkit <me>[dev3] contributor
zz work <me>/mathkit --as dev2 --scope contributor --provider groq
zz work <me>/mathkit --as dev3 --scope contributor --provider groq
```

The bulk post itself is a shell loop over `zz repo ask`, not a dedicated command — a sequence of real, visible posts reads better on camera than one opaque batch call:

```
app/demo/bulk-ask.sh <me>/mathkit app/demo/mathkit-tasks.txt
```

`app/demo/mathkit-tasks.txt` (one task per line, `#` for comments):

```
isPrime(n)
gcd(a, b)
lcm(a, b)
factorial(n)
fibonacci(n)
clamp(value, min, max)
mean(...numbers)
median(...numbers)
roundTo(value, decimals)
isPerfectSquare(n)
```

## Checkpoint

All ten functions merged, claims spread across `dev1`–`dev3` with no two workers claiming the same Ask — `zz lane log <me>/mathkit` shows which worker claimed which.

No cleanup here — [Stage 7](/docs/demos/decomposition/) continues directly on this same `mathkit` repo and fleet, and its own checkpoint is where the whole chain gets cleaned up.
