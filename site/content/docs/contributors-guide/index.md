---
layout: docs
title: "Design sketch: a living contributors guide"
description: "A per-claim guide assembled live from Principles, Policy, and Insights -- not a fourth independent store, a projection of the three that already exist. Depends on Insights (#8) existing first."
---
# Design sketch: a living contributors guide

**Status: sketched, not designed in full.** Deliberately lighter than the other design pages -- the real design pass happens alongside [Insights](https://github.com/zzmq-dev/zz/issues/8), which this depends on and doesn't exist yet.

## The idea

Every actor claiming `work`, `changeset_review`, or `resolve_conflict` gets handed a guide: what's expected, what to avoid, what considerations apply to the area it's about to touch. Not a static file someone has to remember to update -- assembled live, every time, from three sources that already exist:

- **[Principles](/docs/principles/)** -- the global, static layer, same across every repo unless a repo explicitly overrides it.
- **Policy** -- the repo's own path-scoped rules, rendered into prose instead of raw config ("files under `auth/` always get full review from someone other than the author," not a `PathPolicyRule` dump).
- **Insights** -- the dynamic, learned layer. Norms and traps accumulated from real work, scoped the same way Insights are already planned to be scoped (by path/area), surfaced only for the area the current claim actually touches.

## Not a fourth store

This is the load-bearing design constraint, checked directly against [principle #5](/docs/principles/#5-invent-as-little-as-possible): the guide is a computed view over the three sources above, not an independent thing that can drift out of sync with them. "Constantly maintained" falls out for free if it's rendered fresh from current state on every claim rather than snapshotted and edited by hand -- there's no separate update step to forget.

## Where hand-written content lives

A Coordinator should be able to add guidance directly, not only let the system infer it from incidents. That hand-written preface needs a storage location, and it needs to learn directly from a mistake this project just caught itself making: [Lane history living only in the Durable Object](/docs/case-studies/designing-on-principle/) was a real portability violation (principle #3) found during the Principles checkpoint audit. The hand-written preface should live in `zz-meta`, git-tracked, for the same reason -- not DO-only, or it's the same mistake again in a new place.

## Mining history during import

When importing an existing GitHub repo, the same pass that reconstructs Lane history from `git log` ([#29](https://github.com/zzmq-dev/zz/issues/29)) is already doing a structural read of PR threads, issue discussion, and commit messages. Extending that pass to also surface *candidate* Insights -- operating principles that were never written down anywhere, only practiced -- is the same mining pass doing one more kind of extraction, not a second pipeline. This should follow the same discipline already settled for ingest generally: protocol-native, BYO model, not a side-channel script (see [[project_zz]]'s ingest/onboarding correction). Mined candidates most likely need the same confirmation step a real-time-learned Insight gets, once Insights actually specify what that step is -- auto-accepting an LLM's read of old GitHub threads as settled fact is exactly the kind of unconsidered drift the Principles audit exists to catch, not something to build in by default.

## Where it attaches

Automatically, to the context of claiming `work`, `changeset_review`, or `resolve_conflict` -- scoped to the touched area, not the whole repo's guide dumped every time. Not a tool an actor has to remember to call. [Principle #5](/docs/principles/#5-invent-as-little-as-possible)'s cognitive-load argument applies directly: the value of this only holds if receiving it costs nothing extra.

## What's still open

- The full design, blocked on [Insights](https://github.com/zzmq-dev/zz/issues/8) existing first -- storage shape, confirmation/promotion flow for a learned or mined Insight, search/ranking.
- Exact rendering format and how aggressively to scope by touched area vs. giving broader repo context.
- Whether mined candidate Insights get a different trust/confidence tier than ones learned from real-time incidents, given they're inferred from historical text rather than observed behavior.

## Tracked as

- [#34](https://github.com/zzmq-dev/zz/issues/34) Living contributors guide -- full design, once Insights (#8) is scoped.
