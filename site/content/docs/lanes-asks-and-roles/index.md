---
layout: docs
title: "Design: Lane, Ask, and Role boundaries"
description: "The Lane is the singular primitive -- Ask, Ladder, repo, Policy, and Roles are its facets, not peers. Creating a Lane, including an origin Lane, becomes one unified, Ask-driven verb. The Owner/Maintainer/Coordinator confusion turns out to be two narrow, fixable things, not a broken role model -- though the deeper question of collapsing repo-Role into Lane-scoped roles entirely is now open too."
---
# Design: Lane, Ask, and Role boundaries

**Status: designed, mostly not built.** Written after a direct code audit, not from memory of the docs -- several things below are corrections to what the docs currently claim, not just additions. Revised once already, same day, after the model grew from "fix a few confusing boundaries" to "the Lane is the one real primitive."

## The Lane is the singular primitive; Ask, Ladder, repo, Policy, and Roles are its facets

Not five peer concepts that happen to relate to each other -- one thing, with five facets:

- **An Ask** -- specifically, the one that caused this Lane to exist. A Lane receives many Asks over its life (`claim_request`, `changeset_review`, `vote_request`, and so on are all ordinary protocol traffic *within* a Lane); exactly one Ask is the *creating* one, and that relationship is 1:1 in both directions -- every Lane has exactly one creating Ask, every creating Ask produces exactly one Lane.
- **A Ladder** -- its own state/knowledge record, 1:1 with the Lane, following the same origin-chain shape a Lane's own relationships already have: a work Lane's Ladder merges upward into its origin's, the same way the Lane itself traces back to its origin.
- **A repo** -- the backing store, de-emphasized in the UX on purpose. See [Lanes and Ladders](/docs/lanes-and-ladders/).
- **A Policy** -- inherited from the origin at fork time (see below), overridable per path the same way Policy already works.
- **A set of Roles** -- also inherited at fork time, with one addition (see below).

This resolves the question this page opened with under its old framing: a Lane doesn't merely *have* a repo and a Ladder, it *is* the primitive those are facets of. "1 Ask, 1 Lane, 1 Ladder, 1 repo" is really just "1 Lane," stated four different ways.

## Policy and Roles inherit at fork time -- as a snapshot, not a live link

When a new Lane forks from an origin, it inherits the origin's Policy and Role grants as they stood *at that moment* -- with one addition: the actor creating the fork is granted Owner on the new Lane, on top of (not instead of) the inherited owners. The new Lane's owner set is the union of the origin's owners and the forking actor, not a reset.

This should follow the exact snapshot discipline already designed for [agent-creation-chain trust inheritance](/docs/trust-model/#open-the-vouch-graph) -- `inherited_trust(agent) = decay_factor × trust(created_by, at creation time)` -- rather than inventing a second inheritance mechanism for the same shape of problem, per [principle #5](/docs/principles/#5-invent-as-little-as-possible). Concretely: a later change to the origin's owners shouldn't retroactively alter every fork's owner set (the inheritance was a snapshot, not a subscription) -- except, by the same asymmetric-revocation logic trust-inheritance already settled, an upheld whistleblow against an inherited owner probably should cast doubt forward, the same way a compromised signing key casts doubt on signatures that were valid when made. Flagged here as the likely right answer, not yet fully decided -- tracked as its own issue below.

## Creating a Lane, including an origin Lane, is one verb

The gap this closes: an origin Lane currently has no creating Ask at all, breaking the 1:1 relationship above for exactly the one case that matters most (a repo's own root). The fix is a single, unified verb:

```
zz lane create <name> <description> [--origin <lane-ref>] [--from <github-url>] [--policy ...] [--grant ...]
```

- No `--origin`: creates a **root/origin Lane** -- a new, standalone backing repo, never completing, always open to new Asks for the life of the repo. This replaces `zz repo create` outright.
- `--origin <lane-ref>`: forks from that Lane's backing repo to create the new Lane's own. This replaces the sharded claim path's implicit repo-creation (`ensureShard`) with an explicit, named operation.
- `--from <github-url>`: seeds the new Lane's history from an existing GitHub repo instead of from nothing -- ingest becomes a flavor of Lane creation, not a separate pipeline, consistent with [principle #5](/docs/principles/#5-invent-as-little-as-possible).

Every one of these posts a real creating Ask carrying the name, description, and any non-default config (Policy overrides, Role grants) -- including the origin-Lane case. There's no longer a special, Ask-less bootstrap path.

This also makes concrete what was previously the separate, more abstract proposal to make the in-place-vs-sharded claim decision "a Policy question" -- `--origin` *is* that decision, made explicit at the moment of creation rather than implied by which CLI command happened to be used.

## Shard and fork: implementation detail, not user vocabulary

In the UX -- CLI help text, web app copy, docs written for someone using the system rather than extending it -- there's only Lanes and the Lanes related to a Lane, by origin. "Shard" and "fork" stay, scoped deliberately to the moments actually explaining the git mechanics underneath (this page included, and `--from`/`--origin` as flag names are an acceptable, deliberately narrow exception, naming the git-level operation precisely for the one audience -- someone choosing how to create a Lane -- who needs to know it's happening). The relationship graph this produces is structurally isomorphic to a git DAG (a root, descendants) but that's a statement about shape, not rank: a Lane descended from another is a peer of its origin, the same [different but equal](/docs/principles/#2-different-but-equal) argument already applied to identity, now applied to the project's own information architecture.

## Origin Lanes vs. work Lanes: a real lifecycle distinction, entirely undesigned until now

An **origin Lane** -- what the code currently spells `_repo` -- never completes. A **work Lane** is different in kind: it exists for one Ask, has a real beginning and end, and needs an actual answer to "then what" -- dispose of it, keep it for auditability, or dispose of it after some retention window. `LaneStatus` already declares `"merged" | "closed" | "vetoed" | "stopped"` (`engine/types.ts`), but a full-repo check found **zero call sites that ever set any of them** -- the lifecycle is declared and entirely dead. A clean gap, nothing built yet to contradict.

## The database model already has the right shape, on the wrong table

Confirmed directly: `worker/migrations/0007_repo_shard_origin.sql` already adds exactly the right column -- `shard_of_slug TEXT NULL REFERENCES repos(slug)`, a single self-referencing nullable FK -- just on `repos` instead of on a unified `lanes` table. No join/mapping table exists or is needed: the relationship is a strict tree, one parent per node, and the existing tree-walking code (`shardGroupedListHtml`, the recursive shard-cleanup in `webApp.ts`) already walks that single pointer in application code rather than a recursive SQL query. The fix here is relocating this exact column onto `lanes` as `origin_lane_id` (nullable, NULL for an origin Lane), not inventing a new relationship model -- the schema already got this right once.

## Renaming `_repo` to `origin`, and why that's three fixes, not one

The string `"_repo"` is doing three unrelated jobs today, confirmed directly in code, and the code already has its own comment flagging the collision (`webApp.ts:1758`): the root Lane's id (`engine/lane.ts`), the Ladder's root rung path (`engine/ladder.ts`'s `REPO_RUNG_PATH`), and the key in a repo's Policy document governing changes to Policy itself (`repo-policy.ts`). Formalizing "origin Lane" terminology means only the first of these becomes `origin`. The other two are a different axis that happens to share a string with it today; conflating them further would be the opposite of the fix.

## The role confusion, precisely located -- and a bigger question underneath it

Audited directly against `repoMeta.ts`'s actual `RbacRole` type and every real enforcement call site, not against docs or memory. **The role model itself isn't conceptually broken.** Owner/Maintainer/Contributor/Viewer are four real, mostly-distinct repo-level roles, and "Coordinator" was never a fifth one -- it doesn't exist in the `RbacRole` type at all, and [Core Concepts](/docs/nouns/#agent) already correctly scopes it as Lane-only. The confusion traced to two narrow things:

**A misleadingly-named constant.** `worker/src/webApp.ts`'s `COORDINATOR_ONLY_REMOTE_TOOLS` -- named for the Lane-level concept -- gates `commit_changeset` and `ladder_write_rung` on `repoAtLeast(role, "maintainer")`, the repo-level Role, with zero reference to `Lane.coordinators`. A reader has every reason to expect Lane-coordinator semantics and gets repo-Maintainer semantics instead.

**A doc that didn't match its own demo.** [Protocol](/docs/protocol/#incident-response) said "An Owner can invoke [STOP/DROP/ROLL] directly." The demo always used Lane-coordinator authority. Fixed directly in this pass: Lane coordinator is now stated as the normal authority, Owner as a universal override -- the same escape-hatch shape already reconciled with [different but equal](/docs/principles/#2-different-but-equal) for Policy.

**Confirmed thin but real, not broken:** Contributor vs. Viewer differ only in read access to a private repo -- narrow, but a real distinction.

That was the state of the audit as first written. **It doesn't survive contact with "the Lane is the singular primitive" above.** If Policy and Roles are both facets of a Lane, and an origin Lane is just the Lane every other Lane in a repo traces back to, then "repo-level Role" was never really a separate axis from Lane-scoped roles -- it's the Role grants on the origin Lane specifically, wearing a different name. `zz repo grant`'s own awkwardness once nested under `lane` (below) is the symptom; this is the actual diagnosis: **the repo-level `RbacRole` type should very likely retire entirely**, replaced by Lane-scoped role grants everywhere, with "repo-wide" access simply meaning a grant on the origin Lane. Owner's delete/transfer-ownership semantics map cleanly onto "terminate/transfer the origin Lane" -- the same "a repo is one long-lived Lane" framing this project already uses. This is bigger and more consequential than the two narrow fixes above, needs real verification against the full capability matrix the original audit produced before it's implemented, and is tracked as its own issue rather than folded into the smaller ones.

## CLI verb surface, checked against what's actually registered today

Checked directly against `cli/zz.ts`'s real command tree, not assumed:

- `zz repo create` -- becomes `zz lane create` (above).
- `zz repo clone <owner/repo> [dir]` -- becomes **`zz lane checkout`**. "Checkout" never means "create a new thing" in git vocabulary, unlike "clone," which has picked up fork-ish connotations from GitHub culture; this keeps a clean split where `create` is the only verb that ever produces a new Lane.
- `zz repo grant` -- pending the role-axis-collapse decision above; if it lands, this becomes a Lane-scoped grant with no separate repo concept at all.
- `zz repo ask <owner/repo> <description>` and `zz repo asks <owner/repo>` -- **already redundant.** A top-level `zz ask` command group already exists (`ask post`, `ask claim`, `ask answer`, `ask vote-tally`, `ask whistleblow`) -- these two under `repo` duplicate it with an inconsistent singular/plural verb pair in the process. Retire both; add the one piece actually missing, `zz ask list`, matching the `list` convention `zz repo list` and `zz agent list` already use elsewhere.
- `zz repo policy show/set` -- becomes `zz lane policy show/set`, since Policy is a Lane facet now, not a repo one.
- `zz repo submit <owner/repo> <lane-id> <ask-id>` -- becomes `zz lane submit <lane-id> <ask-id>`, dropping the redundant `owner/repo` argument now that a Lane id implies it.
- `zz lane propose <repo> <name>` -- overlaps with the new unified `zz lane create`; needs its own resolution (fold into `create`, or keep as a narrower convenience for proposing a work Lane inside an already-known repo) rather than assumed away here.
- `zz repo delete` -- becomes terminating the origin Lane specifically, a distinct, higher-stakes operation from ordinary work-Lane disposal/retention (already its own issue below).

## Web app and TUI need to move in step with this, not after it

The TUI is reported to already be close to entirely Lane-native in its own vocabulary -- the lighter lift of the two. The web app still has real repo-centric surface (settings pages, the Roles panel, Policy panel) that needs to track whatever the role-axis-collapse decides, not drift from it. Tracked as its own issue so it doesn't get silently deferred past the CLI/engine work it depends on.

## Fixed directly in this pass

[Protocol §Incident response](/docs/protocol/#incident-response) now says the Lane's coordinator holds the normal authority to invoke STOP/DROP/ROLL, with an Owner's universal override stated explicitly as an override, not the primary path.

## Execution plan -- what's filed, and in what order

1. [#35](https://github.com/zzmq-dev/zz/issues/35) Disentangle `_repo`'s three overlapping meanings; formalize the Lane-identity sense as `origin`. Foundational -- do first.
2. [#41](https://github.com/zzmq-dev/zz/issues/41) Decide and implement the role-axis collapse: retire repo-level `RbacRole`, move everything to Lane-scoped role grants, origin-Lane grants standing in for "repo-wide." The big one -- verify against the full capability matrix before implementing. Supersedes #36's narrower fix if it lands; #36 stays open as a fallback otherwise.
3. [#36](https://github.com/zzmq-dev/zz/issues/36) Fix `COORDINATOR_ONLY_REMOTE_TOOLS` naming/enforcement -- narrower fallback if #41 doesn't land first.
4. [#37](https://github.com/zzmq-dev/zz/issues/37) Unify Lane and repo creation under `zz lane create [--origin][--from]`, Ask-driven -- now the concrete resolution of this issue's original, more abstract scope.
5. [#42](https://github.com/zzmq-dev/zz/issues/42) Policy/Role inheritance at fork time as a snapshot, reusing the trust-inheritance pattern -- including the asymmetric-revocation question.
6. [#38](https://github.com/zzmq-dev/zz/issues/38) Wire up real Lane lifecycle: actually set `merged`/`closed`/`vetoed`/`stopped`.
7. [#39](https://github.com/zzmq-dev/zz/issues/39) New Policy axis for completed work-Lane/shard retention -- depends on #38.
8. [#43](https://github.com/zzmq-dev/zz/issues/43) CLI verb cleanup: retire `zz repo ask`/`asks`, add `zz ask list`, `zz repo clone` → `zz lane checkout`, `zz repo policy`/`submit` → `zz lane policy`/`submit`, resolve `zz lane propose` vs. `create`.
9. [#40](https://github.com/zzmq-dev/zz/issues/40) Remove "shard"/"fork" from user-facing language.
10. [#44](https://github.com/zzmq-dev/zz/issues/44) Update the web app and TUI once the above lands -- TUI lower-lift, already mostly Lane-native.

Placed on the [work queue](https://github.com/zzmq-dev/zz/issues/33) as the second step of the next development spike, after local concurrency isolation and before merge resolution -- merge resolution's own work happens inside Lanes, and building more protocol machinery on top of Lane semantics that are about to change is exactly the kind of avoidable rework [principle #5](/docs/principles/#5-invent-as-little-as-possible) argues against.

## Tracked as

- [#35](https://github.com/zzmq-dev/zz/issues/35), [#36](https://github.com/zzmq-dev/zz/issues/36), [#37](https://github.com/zzmq-dev/zz/issues/37), [#38](https://github.com/zzmq-dev/zz/issues/38), [#39](https://github.com/zzmq-dev/zz/issues/39), [#40](https://github.com/zzmq-dev/zz/issues/40), [#41](https://github.com/zzmq-dev/zz/issues/41), [#42](https://github.com/zzmq-dev/zz/issues/42), [#43](https://github.com/zzmq-dev/zz/issues/43), [#44](https://github.com/zzmq-dev/zz/issues/44).
