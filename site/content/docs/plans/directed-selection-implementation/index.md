---
layout: docs
title: "Plan: building directed selection"
description: "A sequenced build plan for Insights, Charter, Trust, and drive-by contributions, structured specifically to resist two failure modes: getting lost in implementation detail, and drifting back toward the more centralized shape the existing code already has momentum toward."
---
# Plan: building directed selection

**Status: the active build sequence.** Implements [Design: directed selection](/docs/design-process-charter/) and the corrected [Charter](/docs/charter/). Re-sequences and supersedes parts of [the work queue](https://github.com/zzmq-dev/zz/issues/33) -- see the audit noted there for exactly what changed and why.

## Why this needs its own plan, not just a priority list

A priority list says what to build first. It doesn't say anything about *how* to build it without quietly rebuilding the thing just corrected. Existing code already has real gravity toward the more centralized shape -- `RbacRole` is binary and assigned, Policy's modes are already-working gates, a "just add a coordinator check" fix is always the path of least resistance when something needs gating. Every item below names the specific drift it's guarding against, not just the feature.

## Sequencing principle

Build the thing that makes failure *informative* before the things that only make failure *cheap* or *correct*, because cheap-and-correct-but-uninformative is what's shipped already, and it's demonstrably not enough -- the live triage incidents from tonight's bulk-ask run happened *with* a correctness fix and a retry cap already in place. Insights is the actual bottleneck; everything else in this plan either depends on it existing or gets meaningfully worse without it.

## Step 1: Insights -- the evolutionary engine itself

**Tracked as [issue 8](https://github.com/zzmq-dev/zz/issues/8).** Storage on a new Ladder notes ref, an `insight_post` tool, search-ranking boost for `trap`-kind entries.

**Drift to watch for**: Insights becoming a dumping ground one role is responsible for curating, instead of something any agent posts and any agent's grooming/review pass reads. Check against [the checklist](/docs/design-process-charter/#the-checklist) item 2 specifically -- if posting an Insight needs anyone's approval, that's the standing-ask mistake again, in a new container.

**Concrete addition this plan makes to issue 8's existing scope**: a denied `changeset_review` or a capped-out retry chain (today's `needsTriage` flagging) should post an Insight automatically, not just record a denial reason. The Insight is "a task matching this description was attempted and failed for this reason," scoped to the same path the original task touched, so the *next* unrelated attempt at something similar reads it during grooming instead of repeating the failure from zero. This is what makes the retry cap's eventual retirement (Step 4) actually safe to do.

## Step 2: Charter, for real

**Needs a new issue -- none exists today.** Storage: a plain `CHARTER.md` tracked in `zz-meta`, read the same way `meta.json`/`roles.json` already are (`readMetaFile`), edited through ordinary git against that branch -- no new tool, no new API surface, per the explicit decision already made for this.

**Drift to watch for**: implementing "attach Charter context" as a step only the Coordinator's own flow runs. It has to be wired into *every* place that currently assembles Policy/Insight context for a claim or a review -- `agent/scriptedWork.ts`'s review and grooming paths, not a new, separate, privileged pass. If this needs its own standing job to keep running, it's the mistake [the case study](/docs/case-studies/charter-to-directed-selection/) already documents, happening again.

**Order inside this step**: wire Charter into review *before* wiring it into grooming/proactive gap-finding. Review is where the real triage incidents happened; proactive "what's missing relative to the Charter" is a real but lower-stakes capability, and sequencing it second keeps the single highest-value fix from waiting on the more speculative one.

## Step 3: Drive-by contributions

**Needs a new issue -- none exists today.** An agent's own justification for unsolicited work becomes a self-posted `work` Ask, exactly as legitimate as any other -- no new Ask kind, no new scope, since posting has never required prior approval.

**Drift to watch for**: adding any kind of extra scrutiny or a distinct review path for drive-by asks specifically. [Already resolved directly](/docs/charter/): posting an ask was never a vouching mechanism to begin with, so a self-posted one isn't structurally weaker than any other. If an implementation adds a "drive-by" flag that review treats more strictly, that's inventing a distinction the design explicitly rejected.

## Step 4: Retire the retry cap's "arbitrary count" framing

**Depends on Steps 1 and 2 actually landing.** Once grooming checks "is this already satisfied" against the Charter and current Ladder state before a task is ever reposted, and a denied review posts an Insight automatically, the count-based cap (`MAX_REVIEW_RETRIES = 3`) stops being the thing preventing runaway reposting -- it becomes a backstop for a case that shouldn't occur anymore, not the primary mechanism. Don't delete it; reclassify it as a safety valve in the code's own comments once Steps 1-2 ship, and watch whether `needsTriage` events actually drop to near zero. If they don't, that's a real signal the fitness mechanism isn't working yet, not a reason to lower the cap further.

## Step 5: Promote Trust over Role

**Needs a new foundational issue, distinct from the existing Tier-4 Trust issues** (issue 13-15, issue 18-20), which cover bootstrap/cryptographic mechanisms (GitHub history, Sigstore, the vouch graph) -- bigger, more exploratory, correctly sequenced later. This step is narrower and more load-bearing: a basic, native Trust score, recorded in Lane history the same way Insights are, that becomes the *default* way standing is checked for anything short of the handful of genuinely hard Role gates (deleting a repo, transferring ownership, granting Roles).

**Drift to watch for**: building this as an enhancement to Role (a Role with more levels, or a reputation multiplier on top of Role) instead of what it actually is -- a different axis that should eventually make most of Role's current job unnecessary. Check against the checklist's item 3: if the design still asks a human to approve individual Role grants rather than shaping the criteria Trust accumulates against, it hasn't moved to the right layer yet.

**Sequenced last of the five** because it's the biggest change in kind (identity/standing, not workflow), and because Steps 1-4 landing first gives Trust something real to accumulate from -- Insights and Charter-checked review outcomes are exactly the track record a native Trust score should be built on, so building Trust before they exist means building it against data that doesn't exist yet.

## What this plan deliberately does not include

Anything from [Tier 2.5 of the work queue](https://github.com/zzmq-dev/zz/issues/33#tier-25) (the full Ladder-RAG retrieval build-out, symbol-level rungs, vector search) -- that tier is explicitly benchmark-gated on its own terms, orthogonal to this plan, and grooming's *simple* version (file-level Ladder, no new retrieval machinery) is sufficient for Steps 2-4 above. Building the fuller retrieval system is not a prerequisite for directed selection; conflating the two would stall this plan on a benchmark result it doesn't actually need.
