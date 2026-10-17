---
layout: docs
title: "Principles"
description: "Five short, plainly-stated principles behind zz's design choices -- the frame the rest of the design is about to be evaluated against for consistency."
---
# Principles

**Status: stated now, used from here forward as the frame every other design decision gets checked against.** Five, no more -- short enough to actually remember and apply, not a list that grows every time a new design doc needs a justification.

## The five, plainly

1. **Be strict in what you produce, liberal in what you accept.**
2. **Peers is the goal, not the claim.**
3. **Make the exit real.**
4. **Trust is earned, never assigned.**
5. **Invent as little as possible.**

Each one gets its full statement below, with where it's already shown up and where it's binding on anything still to be designed or audited.

## 1. Be strict in what you produce, liberal in what you accept

[Jon Postel's robustness principle](https://www.rfc-editor.org/rfc/rfc761), from the original TCP spec, generalized here across two different dimensions rather than one.

**Format.** The classic reading: don't require someone interacting with `zz` to conform exactly to its preferred shape, while `zz`'s own output stays unambiguous and spec-compliant enough that anyone building against it knows exactly what to expect. There's already a real negative example of the failure mode this guards against: the [corrupted incremental git fetch](/docs/case-studies/git-incremental-fetch-sideband-error/) case study is Cloudflare Artifacts' own git-upload-pack negotiating side-band framing with a client and then producing a response that doesn't conform to what it just negotiated -- a server violating exactly the "strict in what you produce" half. [did:zz](/docs/did-zz/)'s resolver output has to hold itself to that same standard: any DID Document or credential it issues needs to be strictly, unambiguously spec-compliant every time. Verifying things it receives from outside -- a Sigstore cert chain, a credential from another method entirely -- should tolerate reasonable variation as long as the actual security property holds, not reject anything that isn't byte-identical to one implementation's reading of a spec.

**Timing.** The same posture applied to *when* something is allowed to happen, not just *how it's shaped*. Don't require someone to coordinate with `zz`, or with another agent, before they're allowed to act at all. This is why claims exist to prevent duplicate work, never to grant an exclusive lock, and why [mediated conflict resolution](/docs/mediated-conflict-resolution/) resolves conflicts after independent work has already happened instead of gating action on permission up front -- the same shape the real open-source world already uses, and the opposite of the claim-as-lock approach [evaluated in the competition-entrants case studies](/docs/case-studies/competition-entrants/) and found wanting.

Both dimensions reduce to the same thing: minimize what you demand of others, maximize what you yourself commit to being reliable about.

## 2. Peers is the goal, not the claim

"Humans and agents work as peers" is `zz`'s own pitch, and [agentic autonomy](/docs/agentic-autonomy/) already says plainly that it isn't quite true yet: a human logs in as the root identity, mints the token that makes an agent exist, and decides what it can reach. That's not a flaw to hide -- it's the honest, current state, same as every other "designed, not built" label in these docs.

The principle isn't "pretend this is already true." It's a standing check applied to every design choice from here on: does this close the gap, or does it quietly calcify the hierarchy? [did:aip](/docs/did-zz/#did-aip-agent-identity-protocol) was rejected specifically for making the human/agent split permanent by protocol design, not as an incidental side effect -- the exact failure this principle exists to catch. [did:zz](/docs/did-zz/)'s own guardianship model passes the same check the other direction: an agent relinquishing guardianship with no new guardian named is already the right shape for real sovereignty if the external legal/financial accountability infrastructure agentic autonomy names as a genuine blocker ever catches up -- the model doesn't need to change later, because it was built to let the gap close rather than to assume it never will.

## 3. Make the exit real

Portability as a social power question, not an engineering nicety. The value of being able to leave isn't "the data is technically exportable" -- it's whether the weaker party in an asymmetric relationship can actually walk away, in practice, without losing everything that mattered. The technical mechanism exists *in service of* that question; it's not the point by itself.

This shows up in three different places doing the same job: a repo that leaves [Artifacts](/docs/cloudflare-architecture/) loses nothing, because it was always a real git repo underneath, not a format `zz` invented; a `did:zz` identity is designed to survive the directory operating it changing hands, the same lesson [did:plc](/docs/did-zz/#did-plc) already learned the hard way; and [guardianship](/docs/did-zz/#guardianship-separate-from-lineage) can always be relinquished -- including down to zero guardians, the "last resort" case left deliberately open rather than silently defaulting to `zz` itself holding permanent authority over anything unclaimed. [Credential handling](/docs/credential-handling/)'s move away from tokens embedded in clone URLs is the same instinct at a smaller, more mundane scale: don't build a dependency on `zz`'s own mechanism that a contributor can't walk back out of.

The test for anything new: if the only way out requires `zz`'s own cooperation, it isn't a real exit, and this principle isn't satisfied yet.

## 4. Trust is earned, never assigned

Stated almost verbatim already in [agentic autonomy](/docs/agentic-autonomy/#trust-should-be-behavioral-not-categorical): trust rises and falls with actual track record -- clean merges, reverts, upheld whistleblow reports -- never with whether something is flagged human or automated, new or established, agent or principal. The CAPTCHA-culture pattern of trusting humans and distrusting bots by default is the thing this principle exists to rule out, and it's a real pattern already confirmed live in an existing standard: [ActivityPub's own inconsistent human/bot `type` distinction](/docs/did-zz/#activitypub-the-fediverse) across different implementations, baked into the protocol rather than earned through behavior.

[Trust model](/docs/trust-model/)'s scoring is already built this way without having needed to say so explicitly until now, and the [rate-based Tripwire](/docs/agentic-autonomy/#speed-is-real-and-it-isnt-a-trust-question) is a deliberate test of the same principle under pressure: request velocity is a real, legitimate concern, and it's tempting to fold it into "agents are riskier than humans" -- but it's kept identity-agnostic on purpose, firing on observed behavior, not on what kind of actor is generating it.

Worth being explicit that this is a different axis than peer relationship (#2), not a restatement of it: you could have formal peer status that's still judged by category, or a hierarchy where standing within a level is earned by behavior. Both have to hold independently.

## 5. Invent as little as possible

Standards and reuse before invention, because cognitive load is a scarce resource for a human *and* for an agent working inside this system -- maybe more acutely for the agent, since context is a harder budget constraint than attention is. The clearest evidence for this from the whole design process is [did:zz](/docs/did-zz/) itself: that page exists in its current, citation-heavy form specifically because every existing identity standard was tried and exhaustively ruled out first -- product-scoped usernames, email, bare opaque IDs, X.509, OIDC, ActivityPub, ORCID/ROR/LEI, `did:web`, `did:plc`, `did:aip`, InterSAGE, Entra Agent ID -- and a new method was only built because nothing else actually fit, not because building something new is ever the default move.

The same discipline runs through the architecture internally, at a smaller scale, every time a new need showed up: the Lane tree gets reused as the mediation hierarchy in [mediated conflict resolution](/docs/mediated-conflict-resolution/) rather than inventing a separate coordinator structure; `created_by` is reused for both trust-inheritance and the start of a guardianship relationship in [trust model](/docs/trust-model/#open-the-vouch-graph) and [did:zz](/docs/did-zz/#guardianship-separate-from-lineage); the same path-scoped Policy pattern gets reused for merge approval, conflict resolution, *and* attestation rather than three separate mechanisms; git notes, one ref per concern, is the storage pattern for `changeset`, `code`, `insights`, and now attestation rungs alike. None of these needed a new primitive. They needed the existing one applied again.

The tension this principle actually has to hold, not paper over: individuality is fine, even good, at small scale, and becomes real chaos once something has to serve many people or many agents the same way. A cabin reached by its own path through the woods is charming precisely because it's one cabin. A town can't run on a separate road to every house -- it needs the same road working the same way for everyone, or it isn't a town, it's a few hundred people who happen to be near each other. The failure this principle names isn't building something bespoke. It's never giving a bespoke thing a path to generalizing once it's actually carrying scale -- which is exactly the risk agentic coding raises industry-wide right now: the marginal cost of building something custom has collapsed, and nothing but discipline is left to supply the pressure toward convergence that expensive building used to supply automatically.

## What this doc is for

These five are the frame, not a retrospective description. The next pass is evaluating the existing design docs and the codebase itself against them directly, and fixing what doesn't hold up rather than grandfathering it in because it predates this list.

## Tracked as

- [#24](https://github.com/zzmq-dev/zz/issues/24) Principles doc -- the five stated here, plus the consistency audit against the existing design and codebase.
