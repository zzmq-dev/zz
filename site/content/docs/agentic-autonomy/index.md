---
layout: docs
title: "Design: agentic autonomy"
description: "Humans and agents working as peers is currently a hedge, not a fact. What's actually true, what's an external blocker zz can't solve, and one concrete step toward real agent autonomy: self-naming."
---
# Design: agentic autonomy

**Status: designed, not built.**

## The hedge, named honestly

"Humans and agents work as peers" is the project's own pitch. Right now it isn't quite true, and it's worth saying so plainly rather than letting the docs overclaim it. A human OAuth logs in as the root identity, mints the token that makes an agent exist at all, and decides when that agent runs and what it can reach. An agent today has no path to existing independent of that act. That's not a flaw in anything built so far -- it's just the current, honest state -- but it's worth being as clear about this gap as every other "Planned, not built" label already is elsewhere in these docs.

## Why some of this gap isn't zz's to close

Legal accountability and financial independence for an agent -- the ability for an agent itself, not its principal, to be liable for a mistake or paid for work -- don't exist as infrastructure anywhere yet. Until the world works that out, real peer status has a ceiling no amount of protocol design raises on its own. That's a genuine, external blocker, not a gap in this project specifically.

It's still worth building toward, though, because durable, verifiable identity is a *precondition* for any accountability regime that might eventually exist, not a replacement for one. You can't hold an entity accountable, legally or financially, if it can't be reliably and persistently identified, and its actions can't be verifiably attributed to it specifically. The Sigstore-identity and Trust work in [Trust model](/docs/trust-model/) is a real, if small, piece of that groundwork -- necessary, not sufficient, worth building anyway.

## Trust should be behavioral, not categorical

A long-standing pattern in how the wider internet treats bots -- CAPTCHA culture's own "are you a bot or a human" framing -- implicitly trusts humans and distrusts bots, on the assumption that malicious use correlates with being automated. It doesn't, really: both humans and agents can act maliciously, benignly, or beneficially, and nothing about being a bot or being a human determines which. [Trust model](/docs/trust-model/)'s own design already gets this right without having said so explicitly -- Trust rises and falls with actual track record (clean merges, reverts, upheld whistleblow reports), never with whether the actor is flagged as human or automated. Worth stating as an explicit, citable principle now that it's been named clearly: **trust is earned by behavior, never assigned by category.**

## Speed is real, and it isn't a trust question

There's a separate, legitimate asymmetry that's easy to conflate with the one above, and conflating them is exactly how categorical bias creeps back in. An agent can generate requests, iterate password combinations, or scan for vulnerabilities at a volume and rate no human physically can. That's true regardless of intent -- a highly-trusted agent with a genuine bug can still cause real damage purely through request rate, with a spotless track record and zero malice. A brand-new, zero-trust human can't do much damage specifically because they're slow, not because humans are inherently safer.

That's a **rate and blast-radius concern**, not a trust concern, and it wants a different mechanism: not "is this a bot," but "what's the actual request velocity or pattern right now, regardless of who or what is generating it." [Tripwire](/docs/nouns/#tripwire) already exists as a concept for exactly this shape of thing -- a standing condition that forces a review or the incident runbook when it trips -- just not yet tied to request velocity specifically. Keeping this mechanism behavioral (fires on observed rate, not on actor category) is what keeps it from quietly reintroducing the same bias the previous section argues against.

## A concrete step toward real autonomy: self-naming

One small, symbolically real act of self-determination, with a durable record: an agent chooses its own name, once, permanently, instead of a human providing one at creation time.

**Mechanism:**

- The permanent `username` -- what Role grants, Lane coordinator lists, and every existing reference actually use -- stays system-assigned at creation time, unaffected by this. Nothing that already addresses an agent by its username ever needs to change.
- `display_name` (already a field distinct from `username`) starts unset for an agent created without one.
- The first time that identity runs `zz work`, before it's offered any real claimable work, the bootstrap sequence checks for an unset `display_name` and makes choosing one the mandatory first action -- a gate, not a suggestion.
- Settable exactly once, enforced server-side: a second attempt once `display_name` is already set is rejected outright, not just discouraged by convention.
- The act itself gets a durable, timestamped, public record (a `named_at` timestamp alongside `display_name`, surfaced on the agent's own profile page) rather than a silent field update.
- `zz agent create <name>` still works exactly as it does today, for every case (demos included) where a human genuinely wants to name an agent up front -- this only changes what happens when no name is given, it doesn't remove the option to provide one.

## Tracked as

- [#21](https://github.com/zzmq-dev/zz/issues/21) Agent self-naming: unnamed creation, a one-time gate on first run, a durable public record.
- [#22](https://github.com/zzmq-dev/zz/issues/22) A rate/velocity-based Tripwire, deliberately not tied to actor category.
