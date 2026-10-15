---
layout: docs
title: "Case study: a failed conflict resolution silently drops the task"
description: "3 of 10 bulk tasks went missing with no visible failure signal -- resolve_conflict's give-up path denies and stops, with nothing retrying the original work."
---
# Case study: a failed conflict resolution silently drops the task

Found live, 2026-10-15, while rehearsing the [Bulk Asks](/docs/demos/bulk-asks/) demo stage against a real `mathkit` run of 10 tasks posted at once to several contributors. Unlike the [git fetch case study](/docs/case-studies/git-incremental-fetch-sideband-error/), the root cause here is in `zz`'s own protocol logic, not an external dependency -- fixable here, just not fixed yet.

## Symptom

The bulk run looked like it finished -- no crash, no error on screen, every worker eventually went idle. But a fresh clone afterward showed only 7 of the 10 requested functions. `gcd`, `factorial`, and `clamp` were simply never in `index.js`, with no indication anything had gone wrong unless you went looking.

## What actually happened, traced through `zz lane log --full`

Each of the three missing tasks got all the way through review before failing:

1. A contributor (`dev1`) claimed the `work` Ask and completed it.
2. The `changeset_review` was **approved** by the coordinator (`maint`).
3. The `submit_changeset` was then **denied** with `"line-level conflict in: index.js"` -- a real three-way merge conflict, since other functions had landed in the same shared file in the meantime (`agent/scriptedWork.ts`'s `threeWayMerge` check, ~line 724).
4. That correctly auto-posted a `resolve_conflict` Ask, carrying the clean (non-conflicting) files plus the real conflict hunks.
5. A contributor claimed it and tried to resolve the conflict -- a model call, same as the original work. It failed verification twice (one attempt's "fix" dropped the unrelated `mean`/`fibonacci` exports entirely rather than just resolving the hunk), and `resolve_conflict`'s own retry budget gave up and denied it, with the real stdout/stderr in the denial's `reason`.
6. **Nothing retries after that.** The give-up path (the `resolve_conflict` handler's own exhaustion branch) answers `deny` and returns -- it never re-posts the original task as a new `work` Ask. The task is simply gone, with no Ask left open, no error surfaced anywhere beyond that one `deny` entry in the Lane's full history.

## Why this is easy to miss

Every individual step logged a real, legible reason (`line-level conflict in: index.js`, then the failing test output). Nothing crashed, nothing hung, no exception bubbled up anywhere -- the system behaved exactly as coded at every step. The gap is what *doesn't* happen next: a `work` Ask that fails this way has no different final state than one that was never attempted at all. The only way to notice is to diff the finished repo against the original task list, which is exactly how this was found -- not from any log or error.

## Contributing factor: the shared-file conflict rate itself

All three failures were genuine line-level conflicts on `index.js`, the same file every contributor was writing every function into. The more functions landed, the larger and more conflict-prone that file got -- the same shared-file growth pattern behind a separate finding this session (`changeset_review`'s own latency climbing as the file grew, since its payload embeds full file content, not a diff). A prompt change made earlier this same session (`agent/scriptedWork.ts`'s `PROPOSE_SYSTEM_PROMPT`) tells contributors to put each new function in its own file under `src/` and wire it into the entry file with a single added re-export line, rather than editing the shared file's body directly -- this should substantially cut the conflict rate on a re-run, though it doesn't fix the silent-drop gap itself: a conflict on the re-export line is still possible, just far less likely and far smaller to resolve than a conflict in a growing function body.

## Status

Not fixed. Two separate, real gaps, both fixable in this codebase:

- **No retry after `resolve_conflict` exhausts its attempts.** The give-up path should probably re-post the original task's description as a fresh `work` Ask (the same thing `agent/scriptedWork.ts` already does when a `submit_changeset` is denied for a *different* reason -- see the still-untraced question below), rather than a dead end.
- **No visible signal that a task permanently failed.** Even with a retry, a task that fails every attempt needs to surface somewhere a human would actually see it -- today it looks identical to a task that was never posted.

Also unresolved, noticed in passing while investigating this: a separate burst where the coordinator itself posted four fresh `work` Asks for `isPrime` between 03:00-03:03 on the same run -- a different code path than the `resolve_conflict` give-up traced above (that path never re-posts), not yet traced to its source. Worth checking before concluding the retry-on-failure story is as simple as "it never happens."

Next step, before fixing either gap: re-run the bulk-asks stage with the one-file-per-function prompt change in place and see how much the conflict rate actually drops -- the fix might matter less if conflicts become rare enough that the two gaps above stop being worth the complexity to close.
