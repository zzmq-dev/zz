---
layout: docs
title: "Demo: Mediated Conflict Resolution"
description: "A real shared-dependency conflict -- gcd's own contract, not just two edits on the same line -- resolved by a real mediation model call, live against the deployed Worker."
---
# Demo: Mediated Conflict Resolution

[Mediated conflict resolution](/docs/mediated-conflict-resolution/) was designed to answer a gap the protocol always had: a `resolve_conflict` Ask that failed its own automatic attempt had no retry and no further process, silently dropping the task. This demo runs the finished mechanism end to end against a real repo on `zzmq.dev` — the conflict, the deadline window, the mediation itself, and the payoff a resolved conflict is supposed to produce: a later contributor's own pre-work search finding the answer before colliding the same way.

- [`demo/mediated-conflict-demo.ts`](https://github.com/zzmq-dev/zz/blob/main/app/demo/mediated-conflict-demo.ts) — the one script this page runs. The two colliding submissions are scripted fixtures, same "the bad/non-deciding actor's half is always a fixture" rule every demo on this project already follows — here it's the two *contributors* playing that role, so the **mediation itself** is the one real decision in the scene, unscripted, a genuine model call against the real deployed Worker.

## Voice-over

> Most merge conflicts are just two edits on the same line — `first_wins` handles those fine, no process needed. This is the other kind: two contributors who never touched the same symbol, and still collide for real. Contributor A ships `gcd` — the classic recursive Euclidean algorithm, throws if you pass it a negative number. Contributor B, working from a base that's already stale, adds `lcm` — and `lcm`'s own code comment says it needs `gcd` to accept a *negative* input, because the scheduler module sometimes passes signed offsets through.
>
> That's a real contract mismatch, not just two lines of text — and it lands as a genuine git conflict because both land in the same spot in the same file. First_wins or coordinator_decides would force a crude pick here: keep A's throwing `gcd` and ship a `lcm` that crashes the first time it's actually used, or keep B's `lcm` and lose `gcd` entirely. Neither is right. This repo's Policy says `mediate` for this path, so a window opens instead of an instant verdict.
>
> Once the window closes, one real model call looks at both sides — not just their diffs, what each one actually *needs* — and decides.
>
> [mediate: synthesize]
>
> It didn't pick a side. It rewrote `gcd` to accept negative input and added `lcm` calling it — a real reconciliation, and it wrote down *why*, as an Insight, right there in the Ladder.
>
> Here's the part that actually matters: a third contributor, later, about to write something that touches the exact same contract — do they hit the same wall Contributor B almost did? They don't, because the very first thing anyone does before writing new code is search the Ladder. The Insight is sitting right there.

## On screen

A terminal running `demo/mediated-conflict-demo.ts`, full screen, real time. Let the mediation call's own reasoning stream to the console — the `REASON:` line it produces is the one sentence that makes this demo land, not the final diff.

## Setup

```
zz login
```

`GROQ_API_KEY` set (`app/.env`) — the mediation call uses Groq by default (`GROQ_MODEL`, default `openai/gpt-oss-120b`); any configured backend works the same way `zz work --as` picks one.

## Run sheet

From `app/`:

```
npx tsx demo/mediated-conflict-demo.ts
```

This creates a throwaway repo, then:

1. Sets `conflict_policy` to `mediate` for `math.js` (`zz repo policy set --conflict-path math.js --conflict-mode mediate` under the hood) — `expiry_hours` shortened just for this take; a real repo leaves the 72h default.
2. Lands Contributor A's `gcd` for real (`commit_changeset`).
3. Posts Contributor B's `lcm` as a real `changeset_review` + `submit_changeset`, based on the now-stale pre-`gcd` commit.
4. Runs the real protocol's own conflict detection (`runCoordinatorSubmitChangeset`) — not scripted, the same three-way merge every submission goes through. It finds the real conflict and opens a `resolve_conflict` Ask with its deadline window (issue 5).
5. Waits for the window to close.
6. Runs the real mediation (`runResolveConflict`, issue 9's no-Jev path) — one model call, unscripted.
7. Prints the resulting commit's content and the Insight it wrote.
8. Runs a real `ladder_search` with the kind of query a later contributor would actually type, and shows the Insight surfacing in the results.

A real transcript, taken from an actual run (abridged):

```
-> The real protocol (not scripted) detects the conflict and opens a resolve_conflict window
   [scripted] line-level conflict in: math.js -- denied ask-..., posted resolve_conflict with a 0.0022h window (conflict_policy: mediate)
-> Waiting 8s for the window to close

=== The mediation itself -- a real model call, no-Jev path ===
   [scripted] mediate: synthesize -- resolved ask-..., wrote a norm Insight: Side A needs a correct gcd
   implementation that guards against invalid (negative) inputs; Side B needs a lcm helper and a gcd that
   can handle negative values. By adapting gcd to normalize inputs (using absolute values) we preserve
   correctness while allowing negatives, and we add the lcm function, satisfying both needs.

   math.js, after mediation:
   export function gcd(a, b) {
     // Accept negative inputs by normalizing to absolute values
     a = Math.abs(a);
     b = Math.abs(b);
     return b === 0 ? a : gcd(b, a % b);
   }

   export function lcm(a, b) {
     // Compute least common multiple; works with signed offsets
     return Math.abs(a * b) / gcd(a, b);
   }

=== The payoff: a later contributor's own pre-work search finds this before colliding the same way ===
-> ladder_search("gcd negative lcm") -- what any later contributor already runs before writing new code
   - (insight_norm) insights/insight-...: Resolved a conflict on math.js via mediation (synthesize): [...]
   Insight surfaced in search: true
```

## Checkpoint

The conflict resolves to a real commit that satisfies both sides' actual need, not a forced pick — confirmed by re-fetching the repo and reading the committed file directly, not just trusting the Ask's own "complete" answer. A `norm` Insight documents the clarified contract, indexed into the same cross-repo Ladder search every ordinary `work` ask already consults before writing new code (`agent/scriptedWork.ts`'s own pre-work `ladder_search` step) — so this isn't a one-off fix, it's a durable fact the next contributor finds for free.

**What this demo doesn't show yet**: a genuine three-or-more-way mediation (several submissions attached to the same window, issue 5's `conflict_attach`) still only weighs the single latest challenger against the existing content, not every attachment against each other — and the Jev-backed path (triage, scoring, a Kialo-shaped argument tree, [issue 10](https://github.com/zzmq-dev/zz/issues/10)) is still just the design doc's own description, not run here. Both are explicitly scoped out of this first pass, not overlooked.

Clean up when done: `zz repo delete <owner>/<the printed repo name>` (the script prints the exact slug at the end).
