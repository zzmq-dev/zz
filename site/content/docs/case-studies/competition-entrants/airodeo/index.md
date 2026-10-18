---
layout: docs
title: "Evaluating AI Rodeo"
description: "A fellow entrant in Cloudflare's \"next git platform\" competition: best-of-N single-owner change racing, not multi-party coordination. What's genuinely worth taking from it, and why the rest doesn't transfer."
---
# Evaluating AI Rodeo

[AI Rodeo](https://github.com/Danishdude45/airodeo) ([live](https://airodeo.dev/#/how)) is another entry in Cloudflare's ["next git platform"](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) competition -- the same one `zz` is built for. It uses the same core primitive (Cloudflare Artifacts forks) and shares a real amount of surface-level framing with `zz` ("the request is the commit," git-native decision records), which makes it worth reading closely rather than waving off as unrelated. Read directly from its README and a real, live race ([`#/i/17`](https://airodeo.dev/#/i/17), a two-line "Sunday hours" change).

## What it actually is

Instead of branches and diffs, Rodeo is built around a single owner's intent: a plain-English change request with optional pass/fail checks. Multiple models ("riders" -- Llama 3.3 70B, Qwen 2.5 Coder 32B, Mistral Small 3.1) build the *same* request simultaneously, each on its own independent Artifacts fork. A separate, larger judge model (GPT-OSS 120B) scores each fork against the owner's checks. The owner reviews a before/after preview rendered straight from the winning fork and clicks yes or no -- "you stop reading diffs, you review outcomes." A PIN gates approval; there's no Role system beyond that one owner.

Technically: one Cloudflare Worker (~3,000 lines), Artifacts for the forks, a hand-rolled ~100-line git implementation ("gitlite" -- blob/tree/commit objects, packfiles, smart-HTTP push, no `git` binary) to let riders push from inside the Worker, D1 for requests/lanes/activity/token ledger, Queues for races and merges. The whole race, including the losing forks' own attempts, gets written to `.rodeo/intents/<id>.md`, committed as a plain file in the tree.

## Why it's an adjacent problem, not the same one

Every rider in a given race is attempting the *identical* request. That's the load-bearing difference from `zz`: there is never a second party with a genuinely different intent in the picture, because a race only ever has one intent -- the owner's. `zz`'s [mediated conflict resolution](/docs/mediated-conflict-resolution/) design exists for the opposite situation: two *different* tasks, from two independent contributors, colliding unexpectedly, sometimes through a shared dependency neither of them declared. Rodeo's model sidesteps that problem by construction rather than solving it -- there's only ever one owner approving one thing at a time, so there's nothing to reconcile between parties.

This also explains why "a merge conflict becomes a re-run" is sufficient for Rodeo as its *only* conflict strategy: when a second request touches a file an earlier one changed, the later request's whole race is replayed against the new main and has to pass the same checks again. No reconciliation is attempted, because what looks like a conflict here is staleness, not disagreement -- there was never a competing intent to begin with. That's a real, independent data point in favor of `zz` treating `first_wins` as its sensible default rather than one equally-weighted option among several: a live, shipped system converged on exactly this as sufficient for its scope.

## Where it's ahead of what it needs to be, and where it's behind

Ahead, in one specific way worth taking: **outcome-based review**. The owner's explicit, structured checks get auto-verified by the judge *before* any diff-reading happens at all. `zz`'s own `changeset_review` is still fundamentally a human or model reading files. There's a real, narrow idea here -- an optional, structured, auto-verifiable checks field alongside a `work` Ask's plain-English description, checked by `run_in_sandbox` or a judge step as a pre-filter, not a replacement for review.

Also worth taking, smaller: **token/cost transparency per request**, surfaced plainly in the UI (token count and AI-call count on every race). `zz` has no equivalent anywhere right now (`zz top`, `zz lane log`).

Behind, by the README's own honest admission: built for "one small demo repo," riders "rewrite whole files" rather than targeted diffs, and conflicts are "detected per file, not per line." `zz` already does real line-level three-way merging (`threeWayMerge`/`git merge-file`), not whole-file replacement -- this is a place `zz` was already ahead before this evaluation, not something the comparison changed.

And simply out of scope for Rodeo, not a flaw in it: no Role system, no Committee, no Vote, nothing past one PIN-holding owner. None of `zz`'s governance half has anything to compare against here.

## One real, worth-naming tradeoff neither side gets for free

Rodeo commits its intent record as a plain file in the tree (`.rodeo/intents/<id>.md`); the [Ladder](/docs/nouns/#ladder) stores the equivalent as git notes in their own ref. Rodeo's choice shows up in an ordinary `git log -p` with zero special tooling; `zz`'s stays out of the diffable history but needs an explicit `refs/notes/*` fetch most casual clients won't do on their own. Neither is strictly better -- it's the same storage decision the Ladder already made deliberately, just resolved the other way. Worth knowing it was a real choice, not an oversight on either side.

## Verdict

A well-executed, narrower-scoped sibling solving "best single attempt for one owner," not a competitor to the multi-party coordination problem `zz` is built for. Nothing here reopens anything in the mediated-conflict-resolution design. The structured-checks idea is the one piece worth actually adding, and it's additive to `changeset_review`, not a reason to revisit it.
