---
layout: docs
title: "Design: the Ladder as a RAG-backed knowledge graph"
description: "The minimal, precisely-bounded context an agent needs for a task, materialized once into a small session buffer instead of either dumping everything into context or re-querying a large backing store on every lookup -- plus the empirical risk the whole premise rests on, and a productization path."
---
# Design: the Ladder as a RAG-backed knowledge graph

**Status: designed, not built. A major, multi-phase initiative, not a single feature.** Explicitly gated on validating its central empirical premise before committing further -- see [The central risk](#the-central-risk-retrieval-recall) below.

## The goal, stated precisely

Before an agent starts a task, it should be able to assemble the smallest set of knowledge -- across repos, modules, files, and eventually symbols -- that's actually relevant to that task, pre-summarized rather than read raw. Smaller context means a less polluted context window, which means better model quality and lower token cost on the same task -- not a tradeoff between the two, the same improvement producing both. "Cached inference": the summarization cost is paid once, at write time, and reused by everyone who later needs to know about that thing, the same way a cache always works.

## What already exists vs. what's genuinely new

Three real pieces of this already exist, not from a plan built for this doc, but because they turned out to be the same shape:

- **Cached-inference summaries.** The Ladder already computes one summary per file at write time (`describeOneFile`) and reuses it until something invalidates it.
- **A real dependency graph.** The SLSA min-reduction work ([trust model](/docs/trust-model/#slsa-and-the-dependency-graph-one-structure-not-two)) already walks a dependency graph (`findDependencyUsage`) for trust propagation. It's the same kind of graph a knowledge-retrieval walk needs -- reused here, not rebuilt.
- **The delivery shape.** The [living contributors guide](/docs/contributors-guide/) (#34) already established "assembled live, attached automatically to context, scoped to the touched area" as the delivery pattern for Policy/Principles/Insights. This extends that same pattern to code/dependency knowledge specifically.

What's actually new: symbol-level granularity (today's rungs stop at the file), an embedding step alongside the existing summarization step, a vector-search backend, a two-phase retrieval protocol, and the session-buffer mechanism that sits between them.

## Architecture

### Symbol-level rungs

The single biggest real gap. A file's rung needs child rungs per symbol (function, class, eventually smaller), not one holistic file-level summary -- everything below only becomes genuinely *minimal* once retrieval can return "what `foo` does" instead of "the whole file `foo` lives in."

### Cached inference extends to cached embedding

Computed alongside each rung's existing summary, at the same write-time moment, from the same content -- not a second content type invented for this. The embedding target is the summary text itself, not raw source, keeping the vector index a pure derived view of what the Ladder already stores.

### The vector index is derived and rebuildable, never the canonical store

Stated as a hard constraint, not a preference, because this project has already caught itself making this exact mistake twice: [Lane history](https://zzmq.dev/docs/case-studies/designing-on-principle/) living only in the Durable Object violated its own portability rule, and the contributors guide's hand-written preface was deliberately specified to live in `zz-meta`, git-tracked, to avoid repeating it. The vector index here is the same pattern a third time: computed from the git-notes-stored rungs, rebuildable from scratch at any time, never the only copy of anything. A `git clone` still carries the repo's entire knowledge graph with it -- the vector index just makes that graph efficiently *searchable*, somewhere that happens to have query infrastructure.

### Two-phase retrieval

**Phase A, harness-enforced, once per task.** The harness -- not the model -- runs an initial query against the global vector index, built from the Ask's own description/scope, before the model ever sees the task. This materializes the session buffer: a small, bounded, in-memory slice of the graph. Harness-enforced specifically because leaving this to the model is the exact "models don't know how to use it" failure this whole design otherwise risks -- if the model skips this step, it silently falls back to reading raw files and the entire cost benefit disappears without anyone noticing.

**Phase B, model-discretionary, throughout the task.** A different kind of lookup than Phase A, not the same search run twice: Phase A is semantic (find what's relevant when you don't yet know what to look for); Phase B is structural, against the already-materialized session buffer -- by symbol name, or one more hop along the reference graph from something already in the buffer. The hard semantic work already happened in Phase A; a small, already-curated buffer doesn't need a second embedding search to query by name.

### Ask grooming: a third use of the same retrieval machinery, and the actual fix for a real live bug

Not a separate system -- a step that runs before Phase A, using the same underlying retrieval, that turns out to directly fix a real bug found live in this project's own bulk-ask demo: a `changeset_review` that keeps requesting changes on an already-fine implementation reposted the same task as a fresh "work" ask indefinitely, with nothing anywhere checking whether the task still needed doing at all. The same function -- `clamp`, `mean`, `median`, `roundTo` -- got committed four separate times in a row; the open-ask count climbed instead of draining. A hard cap on repost attempts is in place now as an immediate safety net, but it only limits the damage.

**Root-caused precisely, not just generically, once a real instance was actually traced:** this usually isn't model non-determinism at all. A task says "implement `isPrime` and add tests"; by the time a contributor picks it up, `isPrime` is already implemented at HEAD (landed by an earlier attempt, or a different contributor entirely). The model correctly notices this and does the only thing left to do -- adds tests. The reviewer, checking the submission against the *original task text* with no way to see that the implementation already exists at HEAD, reads "tests only" as incomplete and requests changes. The model was right; the reviewer was missing the one piece of context that would have told it so. This is why grooming can't be a one-time, pre-task check -- the "is this already satisfied" question has to be answered fresh at *every* review, not just once before the first attempt, since the true state can be stale from the start or change mid-cycle while a chain is still retrying.

Before an Ask is handed to whoever claims it, and again at every review of it, a grooming step:

1. **Determines intent and fleshes it out.** A minimal ask like "implement sum(n)" becomes something more concrete and checkable, the same quality step a human task-writer would do by hand.
2. **Checks whether it's already satisfied, live, against current HEAD -- not a one-time gate.** Queries the Ladder for code that already does what the ask describes, checked fresh at claim time *and* at every review of a submission, not just before the first attempt ever runs. This is the fix for the actual failure traced live: a submission that only adds tests isn't incomplete if the implementation it would have added is already there -- the reviewer needs the same live view of HEAD the groomer does, not a static snapshot from whenever the task was first posted.
3. **Materializes the relevant context into a buffer.** The same Phase A retrieval already specified above, just triggered at grooming time -- "pull the ladder graph that relates" is Phase A, not a second mechanism.
4. **Sets acceptance criteria that account for "already partially done."** Not a fixed checklist decided once and never revisited -- criteria that explicitly allow "the remaining gap is smaller than the original task implied" as a valid, complete outcome, not a partial one. A reviewer checking a standard that already accounts for this converges; a reviewer checking the literal original task text against a codebase that's moved on does not, which is exactly what was observed.

**The buffer is Lane/Ask-scoped, not process-scoped -- a correction to how #50 was first specified.** The original two-phase design treated the session buffer as something the claiming worker's own process materializes for itself. Grooming needs one shared buffer per Ask instead: the worker reads from it while implementing, and the reviewer reads from the *same* buffer -- same context, same acceptance criteria, both sides checking against an identical standard rather than each reconstructing their own view.

**Two versions, split deliberately so the real fix doesn't wait on the bigger build-out.** A simple version needs none of the symbol-level/vector-backed machinery above -- one model call against today's existing file-level Ladder content, asking "does this already exist, and if not, what are the acceptance criteria," ships against what exists right now. The full version (grooming backed by symbol-level retrieval and a real vector-searched buffer) is still correctly gated behind [the retrieval-recall benchmark](#the-central-risk-retrieval-recall) like the rest of this doc.

### Traversal, ranking, and a token budget

Phase A's walk ranks direct dependencies and direct callers above transitive ones, and cuts off on a **token budget**, not a node-count budget -- the entire point is bounding tokens specifically. Not yet designed in detail; flagged under [What's still open](#whats-still-open).

### Lossy summaries -- the edit target still needs full content

The savings have to come from not fully loading everything *adjacent* to a task, never from skipping real content for the thing actually being edited. If the model is changing function `foo`, it needs `foo`'s real source; the summary is for the functions `foo` calls that it merely needs to not misunderstand. Stated explicitly so "minimal context" doesn't quietly become "imprecise editing."

### Cache invalidation is a safety question, not an elegance one

A stale summary doesn't fail loudly -- it tells the model something confidently wrong, which is worse than the model having no information at all. When a symbol changes, its own summary and embedding are obviously stale; whether a *caller's* cached summary (which may describe what calling that symbol does) also needs invalidating is a real, unresolved design question, not an assumed default. Needs a precise answer before this is trusted with anything beyond an experiment.

## The central risk: retrieval recall

The whole premise rests on one empirical claim: that retrieval finds what's actually relevant often enough that the rare miss costs less than the token savings are worth. When retrieval misses something, the model doesn't know what it doesn't know -- it just produces a worse answer, confidently, which is a different and arguably worse failure mode than giving the model too much context. This isn't an architectural question with an architectural answer; it needs a real benchmark -- the same task, with and without bounded retrieval, measuring both token cost and output quality -- before treating "this saves money" as a claim anyone would sell against, paid tier or not.

## A productization path, shaped by what's technically local versus shared

- **Local tier, free.** One repo's own Ladder plus embeddings, computed from content the repo already owns -- this is just the Ladder working as designed, no shared infrastructure required, and charging for it would violate [respect for agency](/docs/principles/#3-respect-for-agency) the same way charging to clone your own repo would.
- **Ecosystem tier, paid.** A shared, zz-wide index covering well-known external dependencies -- expensive to build once (summarizing/embedding a meaningful slice of the OSS world), cheap to serve many customers from after that, the same shared-infrastructure economics real dev-tool SaaS businesses already run on. Needs summaries keyed to exact dependency versions, not generic package names -- an external package evolving independently of any one customer's repo is the same staleness risk as cache invalidation, just across an organizational boundary instead of a time one.

Both tiers wait on the retrieval-recall benchmark above landing with a real, favorable result -- this section describes the shape the business could take, not a commitment to build it before that's known.

## What's still open

- The traversal/ranking policy's exact shape -- how far to walk, what counts as "direct" versus "transitive" for ranking purposes.
- Cache invalidation depth -- does invalidating a changed symbol also walk into its callers, and how far.
- Phase B's exact query shape -- confirmed structural-by-name/graph-hop here, not re-confirmed against a case where the model needs to ask something genuinely fuzzy mid-task.
- The retrieval-recall benchmark's own methodology -- not designed yet, and the thing everything else above is gated on.
- Grooming's "already satisfied" check needs its own precision/recall thinking, same shape as the central risk above but one level earlier: a false "yes, already done" is a missed contribution, a false "no, still needed" is the exact redundant-work problem grooming exists to prevent.

## Tracked as

- [#47](https://github.com/zzmq-dev/zz/issues/47) Symbol-level Ladder rungs -- the foundational prerequisite everything else depends on.
- [#48](https://github.com/zzmq-dev/zz/issues/48) Embedding step alongside existing write-time summarization.
- [#49](https://github.com/zzmq-dev/zz/issues/49) Vector-search backend integration, as a derived/rebuildable index over git-notes rungs -- never the canonical store.
- [#50](https://github.com/zzmq-dev/zz/issues/50) Two-phase retrieval: harness-enforced Phase A, model-discretionary Phase B, the session buffer between them -- now also Lane/Ask-scoped, shared between worker and reviewer, not process-scoped.
- [#51](https://github.com/zzmq-dev/zz/issues/51) The retrieval-recall benchmark -- do this before committing further, not after.
- [#53](https://github.com/zzmq-dev/zz/issues/53) Ask grooming, simple version -- one model call against today's file-level Ladder, ships now, actually fixes the live deny-repost bug.
- [#54](https://github.com/zzmq-dev/zz/issues/54) Ask grooming, full version -- symbol-level retrieval, a real shared buffer, gated behind #51 like the rest of this doc.
