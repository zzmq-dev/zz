---
layout: docs
title: "Design: did:zz, a DID method for humans and agents as unforced peers"
description: "Why every existing identity standard either couples identity to infrastructure that can disappear, or hard-codes agents as permanently subordinate -- and the case for a new, conforming DID method instead of a bespoke scheme."
---
# Design: did:zz

**Status: designed, not built.** This is a rationale-and-shape document, not a submittable formal specification -- the identifier format and delegation model below are settled enough to build against; the full cryptographic/resolution protocol detail a real IETF draft would need is explicitly future work, not pretended-at here.

## The requirement, stated precisely

Four things, together, that no single existing option satisfies:

1. **One identity method, used identically for humans and agents.** Nothing in the method itself -- not the identifier shape, not the document schema, not the resolution process -- should encode "this is a human" or "this is an agent" as a permanent, structural fact. [Agentic autonomy](/docs/agentic-autonomy/) already argues "humans and agents work as peers" should stop being a hedge; a method that bakes the opposite in at the protocol level would foreclose that regardless of anything built on top of it.
2. **Delegation that records lineage without mandating permanent subordination.** An agent created by a human should carry a real, verifiable record of that -- but the record should be a fact about *history*, not a permanent cap on *rights*. An agent earning full, unattenuated standing over time, or a human explicitly relinquishing exclusive management of something it created, both need to be expressible later, by policy, not foreclosed by the identity method itself at creation time. This matters specifically for a future with more agents working *with* people, not strictly *for* them -- a method that can't express that is making a bet about how that future goes, and it's not this project's bet to make at the protocol layer.
3. **Human-readable, not opaque.** Already a settled, lived lesson in this project -- `ask-da665a2223`-style identifiers are a real, ongoing pain point, not a hypothetical one, and nothing here should repeat it.
4. **Standards-conformant where a standard actually exists**, even though the specific method is new. The W3C DID framework is designed to be extended by new methods -- that's why `did:web`, `did:plc`, and `did:aip` all coexist as distinct methods under the same core resolution model. Needing a new method isn't rejecting the standard; it's using it exactly as designed, because no *existing* method's own semantics fit.

## What was actually considered, and why each one falls short

This covers de facto conventions as seriously as formal standards -- a pattern doesn't need a spec number to be worth rejecting for a real, citable reason.

### Product-scoped usernames (Twitter/X, GitHub, Slack, Discord, ...)

The most common identity convention on the internet, and the one with the least to recommend it here. Human-readable, yes -- but unique only *within* one product, never across them (a GitHub `troy` and a Slack `troy` have no relationship at all), with no export or migration path if the product disappears or revokes access -- strictly worse than even `did:web`'s domain-dependency problem, since there's typically no portability mechanism at all, not even a fragile one. Most of these platforms also bake in exactly the categorical human/bot distinction [Agentic autonomy](/docs/agentic-autonomy/) argues against -- a permanent "bot" badge on the account, decided at the platform level, not earned or lost by behavior. No lineage model beyond platform-specific, proprietary, non-portable admin relationships (who installed this Slack bot, which org owns this GitHub App) that don't survive leaving the platform and don't interoperate with anything else.

### Email addresses

What `zz` already uses for human identity, so worth being precise about exactly where it stops being enough. Globally unique and human-readable, genuinely good properties -- but `+`-subaddressing (`troy+fred@gmail.com`), the closest thing email has to expressing "this belongs to that," is not an identity or lineage mechanism at all. It's a mail-filtering convenience: the Sieve "subaddress" extension that formalizes it (RFC 5233) exists so filters can parse a tag, not so a third party can verify who created what. Every `+`-tagged address still resolves to literally the same mailbox from the system's own point of view -- there's no document, no resolution, no verifiable claim, nothing stopping anyone from typing any tag they want, and no cryptographic binding between "troy" and "fred" at all. It's a useful routing convention, worth keeping for that purpose specifically (see the trust model's own notification-routing use), but it was never going to be the identity layer itself.

Sources: [RFC 5321 (SMTP)](https://www.rfc-editor.org/rfc/rfc5321) · [RFC 5322 (Internet Message Format)](https://www.rfc-editor.org/rfc/rfc5322) · [RFC 5233 (Sieve Subaddress Extension)](https://www.rfc-editor.org/rfc/rfc5233)

### Bare opaque identifiers (UUIDs, database primary keys)

The simplest technically-correct option, and the one already lived with and rejected on direct experience, not just principle: this project's own Ask/Lane IDs (`ask-da665a2223`-style) are exactly this, and the actual, ongoing frustration of referring to one in conversation is the empirical case against extending the same pattern to identity. Fails requirement 3 outright; satisfies nothing else well enough to be worth that tradeoff.

### X.509 / PKI certificate chains

The one traditional PKI model with a genuinely native notion of lineage -- an intermediate certificate's Issuer field *is* a real, verifiable "created by" claim, and it's the explicit comparison InterSAGE itself reaches for. Still falls to the same core problem as the agent-specific DID methods below: a cert chain is strictly hierarchical and permanent by construction, with no mechanism for a child certificate to later hold peer standing with its issuer. Distinguished Names are also notoriously unfriendly in practice (`CN=fred,OU=agents,O=troy,...`) -- rarely anything a human actually reads, let alone types.

### OAuth / OIDC `sub` claims

Already a building block `zz` relies on (the OIDC identity Sigstore's keyless signing binds to), but explicitly not sufficient as the user-facing identity itself: a `sub` claim is deliberately opaque by design (a stable, privacy-preserving string, the opposite of requirement 3), scoped per issuer (a Google `sub` and a GitHub `sub` for the same person are unrelated strings with no portability between them), and carries no native lineage model at all.

### ActivityPub / the Fediverse

A real, federated, partially-standardized precedent (`@user@domain.tld` addressing, human-readable and portable across instances of the same software) worth taking seriously -- and a concrete, checked-not-assumed example of exactly the categorical bias problem already named. ActivityPub actors carry an explicit `type` -- `Person` for a human, `Application`/`Service`/`Bot` for everything automated -- and different implementations don't even agree with each other on which type means "bot": Mastodon and GoToSocial use `Service`, the activitystreams vocabulary itself suggests `Application` is more correct, and Misskey treats an `Application` object as a bot actor that Mastodon would classify differently. That's a real standard baking in a permanent, human-vs-bot category distinction at the protocol level, implemented inconsistently across the federation -- the CAPTCHA-culture problem, now confirmed in a live, widely-deployed standard rather than argued abstractly. No native lineage/delegation model beyond that type flag.

Sources: [FEP-2677: Identifying the Application Actor](https://socialhub.activitypub.rocks/t/fep-2677-identifying-the-application-actor/3646) · [Fedify: Bot accounts](https://fedify.dev/manual/pragmatics)

### ORCID, ROR, and LEI

The closest real-world precedent for "a relationship record kept separate from either identity," which is the right general pattern -- just applied to institutional affiliation, not creation or delegation. ORCID identifies individual researchers; organizations get an entirely separate identifier (ROR, GRID, or LEI) -- "they are complementary," per ORCID's own documentation, linked by affiliation records that carry their own start/end dates and persistent identifiers, structurally similar to what a creation-lineage Verifiable Credential would look like here. Still partitioned by category rather than unified, though: a person and an organization are permanently different *kinds* of identifier under this model, never resolved by the same method, which is the same shape of problem as `did:aip`'s principal/agent split, just in a different domain.

Sources: [ORCID: Working with Organization Identifiers](https://info.orcid.org/documentation/integration-guide/working-with-organization-identifiers) · [ORCID: What does an employment affiliation item contain?](https://info.orcid.org/ufaqs/what-information-does-an-employment-item-contain/)

### The DID family specifically

### W3C DID Core

The base framework everything below builds on: a DID resolves to a DID Document carrying verification methods, service endpoints, and identity metadata. Not rejected -- this is what `did:zz` conforms to. The question was never "DID or not," it was "which method, or a new one."

### `did:web`

Resolves via a well-known HTTPS document on a domain (`did:web:example.com` → `https://example.com/.well-known/did.json`). Rejected on well-documented, independently-acknowledged grounds, not a novel objection: domain dependency ("if [the] domain registrar were to take away her domain, she would also lose control of this DID"), an uptime requirement (a downed web server breaks resolution), and a staleness problem ("there's no mechanism for clients to know that it's changed, which means applications may use one that's out of date"). The DID community's own response -- a second effort, `did:webs`, explicitly built "similar to how Web infrastructure progressed from the insecure `http:` to the secure `https:` protocol" -- is itself independent confirmation this is a real, recognized weakness, not an edge case. Coupling identity to whichever domain `zz` happens to use today would also contradict this project's own existing portability principle (a repo already has to survive leaving Cloudflare without losing anything that matters; identity shouldn't be more fragile than code).

Sources: [Too Many Words About DIDs](https://steveklabnik.com/writing/too-many-words-about-dids/) · [did:webs public review announcement](https://trustoverip.org/news/2023/12/15/announcing-public-review-of-the-didwebs-method-specification/)

### `did:plc`

Bluesky's own method, built specifically to avoid `did:web`'s domain coupling: identity resolves through a directory (`plc.directory`) instead of DNS, supports registering additional keypairs to rotate signing keys away from platform-generated ones, and gives a real, if rarely-used, exit path -- a user can run an independent Personal Data Server and migrate keys to full independence. Worth being precise about what this actually buys, though, rather than overselling it: it is **not** trustless relative to `did:web`, it swaps *which* party is trusted -- "before, I had to trust the DNS system and domain registrars, now I have to trust `plc.directory`." That's a real, honest tradeoff, not a flaw unique to this method; every directory-resolved identity scheme makes the same trade.

What's worth keeping from this, directly: the directory-resolution model (and `zz` is already structurally the trusted party in this exact shape -- it already operates account resolution, OAuth login, and token issuance, so formalizing that as a directory is recognizing an existing trust relationship, not creating a new one), key rotation as a real mechanism, and the explicit philosophy that most identities stay on the hosted default while the architecture leaves a genuine exit open rather than forcing self-hosted key management on everyone.

What it doesn't give at all: `did:plc` has no native delegation or lineage model whatsoever. A `did:plc` identity is flat and independent by design -- it doesn't know or care whether another identity created it. That's not a defect in `did:plc` for Bluesky's own purposes, but it means adopting it as-is would still require bolting on something else entirely for requirement 2.

Source: [Too Many Words About DIDs](https://steveklabnik.com/writing/too-many-words-about-dids/)

### `did:aip` (Agent Identity Protocol)

The closest-looking fit on first read, and the one worth the most detailed rejection, because the gap isn't a missing feature -- it's a conflicting design goal, confirmed by reading the actual draft rather than a summary of it. The spec defines an agent as "an autonomous software system powered by a large language model that can perceive inputs, reason about them, and execute actions in the world on behalf of a principal," and a principal as "the human or organisational entity on whose authority an agent acts." Then, unambiguously:

> "Principals are identified by W3C DIDs, but NOT by `did:aip` (which is reserved for agents)."

> The decoded `principal_token` payload `principal.id` "MUST NOT be a valid W3C DID."

This is a hard, permanent partition at the protocol level: humans and organizations are root authorities only, forever; agents are delegated subordinates only, forever; a principal can delegate *to* an agent but can never, by the method's own validation rules, be delegated *to*. Adopting this wouldn't just fail requirement 1 (no unification -- principals and agents are structurally different categories with different DID methods) -- it would actively **codify requirement 2's opposite** as a standards-level fact. The exact hierarchy [Agentic autonomy](/docs/agentic-autonomy/) argues against would become unfixable by policy, because the identity method itself forbids an agent from ever holding principal-shaped standing.

Source: [draft-singla-agent-identity-protocol-00](https://www.ietf.org/archive/id/draft-singla-agent-identity-protocol-00.html)

### InterSAGE and Microsoft Entra Agent ID

Both real, relevant precedent for one specific idea worth keeping -- capability attenuation, the rule that a child can never hold more capability than the identity that created it -- and both still share `did:aip`'s underlying shape in a way that keeps them from being adoptable wholesale. InterSAGE models delegation as "a parent requests the kernel to issue a child AIC with strictly attenuated capabilities, forming a cryptographic chain analogous to an X.509 intermediate-CA hierarchy," with an explicit `max_delegation_depth` bounding the chain -- a real, well-reasoned safety property, and the formal version of the "an agent shouldn't be able to act against its own creator" guardrail already proposed in this project's own trust-model work, arrived at independently. Microsoft Entra Agent ID similarly introduces "a two-level identity hierarchy with Agent Identity Blueprint as the parent app registration and Agent Identity as a child representing a specific running instance." Neither is adoptable as the base method: InterSAGE is a research-stage protocol for agent-to-agent trust specifically, not a general identity method with its own resolvable DID; Entra Agent ID is a proprietary Microsoft enterprise IAM feature, not an open, federatable standard. And both assume delegation is strictly downward and permanent by default, the same underlying asymmetry as `did:aip`, just without `did:aip`'s explicit prose saying so -- a parent always bounds a child, never the reverse, with no stated path for that to change.

Sources: [InterSAGE](https://arxiv.org/pdf/2608.13030) · [Agentic AI Identity & Access Management](https://cloudsecurityalliance.org/artifacts/agentic-ai-identity-and-access-management-a-new-approach)

### Verifiable Credentials -- not rejected, adopted as a component

The W3C VC data model is the actual mechanism `did:zz` uses for delegation, not a competing identity scheme. A VC issued by a creating identity to a created one, recording "this identity was created by that one, at this time," works identically regardless of what kind of entity is on either end -- which is exactly what none of the delegation-specific prior art above actually offers.

### Sigstore and SLSA -- not rejected, already adopted elsewhere

Already the identity and attestation mechanisms in [Trust model](/docs/trust-model/), at a different layer than this document: Sigstore's keyless signing handles short-lived, per-signing-event keys; `did:zz` handles the longer-lived question of what an identity *is* and how it's resolved. Complementary, not overlapping.

## The shape of `did:zz`

- **Conforms to W3C DID Core.** `did:zz:<name>` resolves to an ordinary DID Document -- nothing about the document schema distinguishes a human-controlled identity from an agent-controlled one.
- **The method-specific identifier is the globally-unique, self-chosen name itself** (`did:zz:fred`), not an opaque string with a separate display layer bolted on. Global uniqueness (already the direction settled on for agent self-naming) makes this possible directly -- human-readable and canonical are the same thing here, deliberately, rather than two things that need reconciling.
- **Directory-resolved, `did:plc`-style**, operated by `zz` initially (consistent with `zz` already being the trusted account/token authority today), with the same stated philosophy `did:plc` and this project's own existing repo-portability principle already share: most identities stay on the hosted default, and the architecture leaves a real, not-merely-theoretical path to independent resolution for anyone who wants it, rather than forcing self-hosted key management as a precondition for anyone to participate.
- **Key rotation** as a first-class operation, same mechanism `did:plc` already proves out, independent of Sigstore's own separate, shorter-lived ephemeral-signing layer.
- **Delegation is a Verifiable Credential, not a protocol-level cap.** A creating identity issues a VC to the one it creates, recording the fact of creation. Capability attenuation (an agent starting out scoped to less than its creator) is something a creator can choose to express *in that credential* at creation time -- a policy decision, inspectable and revisable, never a permanent property the identity method itself enforces. An agent operating fully unattenuated, or a creator later relinquishing exclusive management, are both just different credentials, not different methods or different classes of identity.

## What's still open

- Full formal resolution/cryptographic protocol detail -- this document specifies the shape and the reasoning, not a submittable draft.
- Exact directory operation model (single `zz`-operated directory to start, versus a path toward multiple independent operators the way `plc.directory` itself has discussed) -- settled in spirit (hosted default, real exit path), not in mechanism.
- How a `did:zz` identity interoperates with an external DID an agent or human might already hold (someone already has a `did:plc` from Bluesky, say) -- not addressed here.

## Tracked as

- [#23](https://github.com/zzmq-dev/zz/issues/23) Design and implement did:zz. Supersedes part of [#21](https://github.com/zzmq-dev/zz/issues/21)'s original mechanism (noted there); sits underneath [#15](https://github.com/zzmq-dev/zz/issues/15)'s Sigstore identity work and [#19](https://github.com/zzmq-dev/zz/issues/19)'s creation-chain trust inheritance without changing either's own design.
