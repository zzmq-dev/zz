---
layout: docs
title: "Design: Lane, Ask, and Role boundaries"
description: "The Ask-to-Lane-to-repo relationship splits into two real paths that were never named as a deliberate choice; Lane lifecycle is declared but never wired up; and the Owner/Maintainer/Coordinator confusion turns out to be one misleadingly-named constant and one doc that doesn't match its own demo code, not a conceptually broken role model."
---
# Design: Lane, Ask, and Role boundaries

**Status: designed, mostly not built.** Written after a direct code audit, not from memory of the docs -- several things below are corrections to what the docs currently claim, not just additions.

## The Ask/Lane/repo relationship is two real paths, currently unnamed

"Claiming an Ask creates a Lane" is true everywhere. "One Ask, one Lane, one repo" is true for exactly one of the two paths that actually exist in the code today:

- **In-place** (`cli/commands/ask-claim.ts`): claiming proposes a Lane directly in the same repo. No new repo. The file's own header already says so explicitly -- "no sharding/forking, that's the remote-autonomous-agent path's own thing."
- **Sharded** (`agent/scriptedWork.ts` / `ensureShard` in `worker/src/webApp.ts`): claiming forks a brand-new repo first, then proposes the Lane inside it.

Both are legitimate. Neither is wrong. What's actually missing is that this is currently decided by *which CLI entry point happened to be used*, not by any stated rule -- it reads as an implementation accident, not an architectural choice. It should be a real decision: whether a claimed Ask gets isolated into its own repo or works in the origin's own history should probably be a **Policy question** (the same shape as every other per-path Policy axis already designed), not a side effect of which tool called it.

One more thing worth being explicit about, surfaced directly by the audit: `ensureShard` makes the claiming actor the new shard's **Owner**, not Maintainer or Contributor. That's an intentional, examined choice, not an oversight, once named -- it's the direct, concrete application of [respect for agency](/docs/principles/#3-respect-for-agency): claiming work means being handed real control over your own derived scope, not permission mediated through someone else's continued authority over it.

## Origin Lanes vs. work Lanes: a real lifecycle distinction, entirely undesigned until now

An **origin Lane** -- the root Lane of a repo, what the code currently spells `_repo` -- never completes. It's always open to new Asks for the life of the repo, the same shape [an earlier design pass](/docs/lanes-and-ladders/) already described ("a whole repo can be seen as one Lane that starts with a 'create repo' action and runs indefinitely").

A **work Lane** is different in kind, not just in name: it exists for one Ask, has a real beginning and a real end, and needs an actual answer to "then what" -- dispose of it, keep it for auditability, or dispose of it after some retention window. None of that exists today. `LaneStatus` already declares `"merged" | "closed" | "vetoed" | "stopped"` (`engine/types.ts`), but a full-repo check found **zero call sites that ever set any of them** -- the lifecycle is declared and entirely dead. This isn't a case of reconciling old behavior against a new principle; it's a clean gap, nothing built yet to contradict.

## Renaming `_repo` to `origin`, and why that's three fixes, not one

The string `"_repo"` is doing three unrelated jobs today, confirmed directly in code, and the code already has its own comment flagging the collision (`webApp.ts:1758`):

1. The root Lane's id (`engine/lane.ts`).
2. The Ladder's root rung path (`engine/ladder.ts`'s `REPO_RUNG_PATH`).
3. The key in a repo's Policy document governing changes to Policy itself (`repo-policy.ts`).

Formalizing "origin Lane" terminology means (1) becomes `origin` as a real, user-facing concept -- the Lane every other Lane in a repo ultimately traces back to. It does **not** mean renaming (2) or (3) to match; they're a different axis that happens to share a string with (1) today, and conflating them further would be the opposite of the fix. The actual work is giving each of the three its own distinct identifier so a future reader isn't stuck guessing which `_repo` a piece of code means, the way this audit just had to.

## Shard and fork: implementation detail, not user vocabulary

In the UX -- CLI help text, web app copy, docs written for someone using the system rather than extending it -- there's only Lanes and the Lanes related to a Lane, by origin. "Shard" and "fork" stay, scoped deliberately to the moments actually explaining the git mechanics underneath (this page included). The relationship graph this produces is structurally isomorphic to a git DAG (a root, descendants) but that's a statement about shape, not rank: a Lane descended from another is a peer of its origin, the same [different but equal](/docs/principles/#2-different-but-equal) argument already applied to identity, now applied to the project's own information architecture.

## The role confusion, precisely located

Audited directly against `repoMeta.ts`'s actual `RbacRole` type and every real enforcement call site, not against docs or memory. The headline finding: **the role model itself isn't conceptually broken.** Owner/Maintainer/Contributor/Viewer are four real, mostly-distinct repo-level roles, and "Coordinator" was never a fifth one -- it doesn't exist in the `RbacRole` type at all, and [Core Concepts](/docs/nouns/#agent) already correctly scopes it as Lane-only. The actual confusion is two specific, narrow things:

**A misleadingly-named constant.** `worker/src/webApp.ts`'s `COORDINATOR_ONLY_REMOTE_TOOLS` -- named for the Lane-level concept -- gates `commit_changeset` and `ladder_write_rung` on `repoAtLeast(role, "maintainer")`, the repo-level Role, with zero reference to `Lane.coordinators` anywhere in the actual check. A reader (human or agent) encountering that name has every reason to expect Lane-coordinator semantics and gets repo-Maintainer semantics instead. This needs an actual decision, not just a rename: should these two actions check `Lane.coordinators` for the specific Lane being committed to, repo Maintainer, or both? Given these are fundamentally Lane-scoped actions (committing a changeset *for* a Lane), the more consistent answer is likely both -- repo Maintainer as "can touch this repo at all," `Lane.coordinators` as "authorized for this specific Lane's merge" -- but that's a real design decision for the issue tracking this, not something to settle by renaming alone.

**A doc that doesn't match its own demo.** [Protocol](/docs/protocol/#incident-response) says "An Owner can invoke [STOP/DROP/ROLL] directly." The actual implementation (`demo/governance-and-incident-demo.ts`) invokes it as the coordinator of the root Lane -- Lane-coordinator authority, not a repo-Role check. The two only ever coincided because the root Lane's coordinator defaults to the repo's Owner. The resolution, consistent with how Policy's own Owner-override already works: **Lane coordinator is the normal authority; Owner retains a universal override**, the same escape-hatch shape already reconciled with [different but equal](/docs/principles/#2-different-but-equal) for Policy. Fixed directly in this pass -- see below.

**Confirmed thin but real, not broken:** Contributor vs. Viewer differ only in read access to a private repo. Narrow, but a real distinction, not an accidental one -- no action needed.

**The actual root of the sense that boundaries are unclear:** Maintainer (repo-level) and Lane-coordinator (per-Lane) are genuinely separate axes with no stated narrative anywhere for why, that happen to default to the same people on the root Lane. They were never reconciled because nothing ever required them to coincide anywhere except by default. Naming this plainly is most of the fix -- the two axes are allowed to diverge (a repo Maintainer who isn't a given Lane's coordinator, and vice versa), and now it's written down instead of silently assumed.

## Fixed directly in this pass

[Protocol §Incident response](/docs/protocol/#incident-response) now says the Lane's coordinator holds the normal authority to invoke STOP/DROP/ROLL, with an Owner's universal override stated explicitly as an override, not the primary path -- matching what the code and demo already do, rather than contradicting them.

## Execution plan -- what's filed, and in what order

1. [#35](https://github.com/zzmq-dev/zz/issues/35) Disentangle `_repo`'s three overlapping meanings; formalize the Lane-identity sense as `origin`. Foundational -- do first, before anything else below touches the same code.
2. [#36](https://github.com/zzmq-dev/zz/issues/36) Fix `COORDINATOR_ONLY_REMOTE_TOOLS`: decide and implement real `Lane.coordinators` vs. repo-Maintainer semantics for `commit_changeset`/`ladder_write_rung`. Real bug, not just a rename.
3. [#37](https://github.com/zzmq-dev/zz/issues/37) Name and formalize the in-place vs. sharded claim paths as a deliberate, Policy-governed choice rather than an accident of CLI entry point.
4. [#38](https://github.com/zzmq-dev/zz/issues/38) Wire up real Lane lifecycle: actually set `merged`/`closed`/`vetoed`/`stopped`, and formalize origin-Lane-never-completes vs. work-Lane-has-a-lifecycle as enforced behavior, not just a status enum nothing uses.
5. [#39](https://github.com/zzmq-dev/zz/issues/39) New Policy axis for completed work-Lane/shard retention (dispose / keep for audit / TTL) -- depends on #38 landing first.
6. [#40](https://github.com/zzmq-dev/zz/issues/40) Remove "shard"/"fork" from user-facing language across CLI help text, web app copy, and docs -- keep only where git mechanics are being deliberately explained.

Placed on the [work queue](https://github.com/zzmq-dev/zz/issues/33) as the second step of the next development spike, after local concurrency isolation and before merge resolution -- merge resolution's own work happens inside Lanes, and building more protocol machinery on top of Lane semantics that are about to change is exactly the kind of avoidable rework [principle #5](/docs/principles/#5-invent-as-little-as-possible) argues against.

## Tracked as

- [#35](https://github.com/zzmq-dev/zz/issues/35) through [#40](https://github.com/zzmq-dev/zz/issues/40), listed in execution order above.
