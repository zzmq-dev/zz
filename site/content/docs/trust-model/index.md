---
layout: docs
title: "Design: trust model"
description: "Identity without key custody, reputation that feeds merge-conflict mediation, trusting Artifacts itself, and a dependency graph of SLSA attestations -- building on GitHub issue 2."
---
# Design: trust model

**Status: designed, not built.** Builds directly on [GitHub issue 2](https://github.com/zzmq-dev/zz/issues/2), which first named Sigstore, SLSA, and the ring-of-trust/key-signing question. The vouch graph -- how a new agent or repo starts with something better than zero trust -- is the one piece this page leaves open; see [Open: the vouch graph](#open-the-vouch-graph).

## Two different things are called "trust" here, and they don't resolve the same way

**Trusting an agent** splits further into identity ("you are who you say you are") and reputation ("you're a good-faith actor"), and **trusting Artifacts itself** -- the platform, not any agent -- is a third, separate relationship `zz` currently has none of: it trusts Cloudflare's API responses completely, with no way to independently verify history hasn't been tampered with.

**A scoping note, deliberately not a redesign.** None of identity, reputation, or attestation is inherently SCM-specific -- there's real applicability well beyond git coordination. That doesn't mean splitting this into a standalone product now, before a single piece of it has a real, working implementation anywhere: an abstraction designed before it has even one concrete consumer tends to fit that consumer badly and fit the imagined future ones just as badly, since neither shape gets tested against anything real. The discipline that actually pays off here is cheaper than a spin-off -- build this as a cleanly-bounded internal module, deliberately not leaking `zz`-specific concepts (Lane, Ask, Ladder) into its own core logic even though `zz` is its only consumer today, so extraction later is a clean move instead of a rewrite if a second real use case ever shows up. Everything below should be read with that constraint in mind.

## Identity: Sigstore, not key-signing parties

The real, hard problem here is the one [issue 2](https://github.com/zzmq-dev/zz/issues/2) already names: managing cryptographic key material at scale, securely, across distributed agents. Long-lived keys are genuinely hard to manage safely at that scale -- that's not an incidental difficulty, it's *why* the industry built [Sigstore](https://www.sigstore.dev/)'s keyless-signing model (`cosign` + Fulcio + Rekor) in the first place. An ephemeral keypair gets minted and bound to an existing OIDC identity, signs once, and the certificate expires in minutes; the signing *event* -- not a long-lived key -- is what gets recorded, in a public transparency log (Rekor). Nobody holds a durable private key at all.

**A real blocker, found live, 2026-10-19 (issue 15).** The paragraph above describes the intent correctly; the next sentence used to claim `zz`'s own `zz login` identity could mint a Fulcio cert directly. It can't. Confirmed directly against Fulcio's own live public-instance configuration (`https://fulcio.sigstore.dev/api/v2/configuration`): Fulcio's issuer allowlist is keyed on *(issuer, audience)* pairs, not bare issuer -- `accounts.google.com` is allowed, but only for a token whose `aud` claim is the literal string `"sigstore"`. A token from `zz`'s own Google OAuth app (or Cloudflare's, or GitHub's -- neither of those issuers is on the allowlist at all) has `zz`'s own client ID as its audience, and Fulcio rejects it outright ("error processing the identity token," reproduced live). This isn't a `zz`-side bug to fix -- it's how Fulcio's public instance is designed to work, full stop.

Two real paths forward, not one:

- **Phase 1, no new infrastructure**: Sigstore runs its *own* independent OIDC login (Dex, at `oauth2.sigstore.dev`, public client id `"sigstore"`), itself federating Google/GitHub/Microsoft. A human can sign today by going through *that* login at signing time -- completely separate from however they logged into `zz` -- using `@sigstore/cli`'s own `OAuthIdentityProvider` (a local-callback-server + browser flow, the same shape `gh`/`gcloud` already use) or an equivalent built directly on `openid-client`. Real, works now, zero new `zz` infrastructure -- but only ever covers a human at the keyboard willing to click through a browser login each time (or each time a locally-cached refresh token expires, if Dex issues one -- not yet confirmed).
- **Phase 2, a private Fulcio/CA instance**: the only path that covers a *managed* agent, which has no OIDC identity of its own at all -- Fulcio's keyless model fundamentally requires a real ID token bound to the signing principal, and a managed agent only ever has a `zz`-minted bearer token, never an OIDC token from an allowlisted issuer. Running `zz`'s own Fulcio (trusting `zz`'s own tokens) is real infrastructure -- a certificate authority, its own root of trust, key management -- not a feature-sized implementation.

**Decided 2026-10-19: defer both phases until Phase 2's own CA exists**, rather than ship Phase 1 as a human-only, agent-excluded interim (which would need throwing away once Phase 2 lands anyway). Tracked as its own planning item -- see [issue 15](https://github.com/zzmq-dev/zz/issues/15)'s own comment thread for the full investigation.

This page's own identity model is being superseded by [Design: did:zz](/docs/did-zz/) -- Sigstore stays exactly as described here (short-lived, per-signing-event keys), now sitting on top of `did:zz` identities instead of raw OAuth accounts.

This is also why literal PGP-style key-signing parties -- a real, legitimate precedent, ASF's own actual practice -- aren't the mechanism to build toward, despite being the most direct reading of "ring of trust." They're the older approach to the same underlying need, superseded industry-wide for the exact reason named above. The goal survives; the mechanism should be the one that already solved the key-management problem, not the one that motivated solving it.

## Reputation: already named, just not built yet

[Trust](/docs/nouns/#trust) already exists as a concept -- planned, not built: scored per area, rising with clean merges, falling with reverts and upheld whistleblow reports. Two things extend it rather than replace it:

**It should feed merge-conflict mediation.** [Mediated conflict resolution](/docs/mediated-conflict-resolution/)'s `mediate` mode falls back to objective criteria (existing tests, the Ladder's documented contract, established convention) when no mutual-gain synthesis exists. Trust-in-this-area is a natural fourth entry on that list -- when nothing else settles it, the higher-Trust party's position weighs more. A small, direct addition to an already-written design, not a new mechanism.

**It can bootstrap from GitHub history, carefully.** A new identity doesn't have to start at zero if there's real prior public evidence of good-faith contribution elsewhere. The naive version of this -- matching commit author emails -- doesn't work: `git config user.email` is self-reported and unauthenticated, so anyone can pad a score by committing under someone else's real email to a repo they control. The signal that's actually robust is GitHub's own *verified* commit status (attribution plus a signing key GitHub has already confirmed belongs to the account), and the single strongest signal available is **PRs merged by someone else** -- a third party's own review, already public, much harder to fake than pushing to your own repos. Raw commit counts, followers, and stars on one's own repos should stay out of the scoring entirely; all three are cheaply gameable and none of them represent anyone else's judgment.

This also surfaces a real prerequisite: `zz` has Cloudflare and Google OAuth, not GitHub. Without "Sign in with GitHub," a claimed GitHub identity is just a self-reported string, and the entire bootstrap is only as trustworthy as that unverified claim -- GitHub OAuth is load-bearing for this, not optional polish.

## Trusting Artifacts itself

A transparency log answers a genuinely different question than agent identity does. If signing events land in a public, third-party-maintained log -- Sigstore's own Rekor instance is free, already running, and already trusted well beyond anything `zz` could stand up itself -- anyone can verify a commit's signature was logged at a given time, independent of whatever Artifacts' own API reports. If Artifacts were ever compromised or simply wrong, tampering would be detectable, because the record of record isn't Artifacts' own say-so.

## SLSA and the dependency graph: one structure, not two

A build's real guarantee is bounded by its weakest attested dependency -- this is standard SLSA thinking, not a `zz`-specific idea, and it means SLSA level is a *computed*, graph-propagated property, not a per-artifact flag. `zz` already has the dependency half of this: dependency rungs, `findDependencyUsage`. Adding attestation rungs (another git-notes ref, same pattern as `changeset`/`code`/`insights`, anchored to the commit they attest to, carrying the Fulcio cert chain and Rekor log reference) gives the other half for free. Effective SLSA level for any node is then:

```
effective(node) = min(node's own attestation level, min(effective(dep) for dep in node's dependencies))
```

A standard min-reduction over the dependency DAG, computable once and cached the same way other Ladder derivations already are. One real gap worth naming up front: an external dependency (an npm package `zz` didn't build) has no `zz`-native attestation unless its own upstream already publishes one -- increasingly true in practice, since GitHub's own Artifact Attestations feature produces exactly this for packages built through it. The computation needs to check for and ingest an externally-published, independently-verifiable attestation where one exists, rather than defaulting a whole subtree to `none` just because it's outside `zz`.

## `attestation_policy`: opt-in, same pattern as the other two

Signing and attesting every merge is real overhead that most repos won't want by default -- this is a genuine, not universal, need. Security-conscious and regulated users would want it early and care a lot; most repos wouldn't need it on day one. Same shape as the merge-approval and conflict-resolution Policy axes already designed: a third, path-scoped axis, `none` (default, zero overhead) / `signed` (every merge gets a Sigstore-style attestation) / `slsa_l3` (full isolated-build provenance), set per repo or per path, not mandatory weight on everyone.

## Open: the vouch graph

Not fully designed here on purpose -- still the next thing to work out in full. What's settled enough to build on: it's a graph recorded natively in Lane history (an established Coordinator explicitly vouching for a new contributor; a delegated Lane inheriting some baseline standing from its origin repo), not external key-signing mechanics. GitHub-bootstrapped trust (above) is naturally one *kind* of edge into this graph -- an external, verified-history-sourced vouch, alongside native ones -- not a separate, competing mechanism.

**One edge type is concrete enough to specify now: trust inherited through the agent-creation chain itself.** Checked directly against real prior art first -- the closest existing work ([Sigstore-style provenance for AI agents](https://nolabs.ai/blog/sigstore-ai-agent-provenance)) attests each agent invocation as a discrete, independent unit; it doesn't propagate trust from a creating principal to spawned agents. That's a real gap, not something to copy in.

The mechanism, and where it has to diverge from SLSA's own model rather than copy it directly: SLSA's min-reduction (see above) is a *permanent* fact about how an artifact was built -- a build doesn't earn a higher level later by behaving well, because provenance is a historical fact, not an ongoing score. An agent is accountable for its own behavior going forward, so inherited trust should be a **one-time bootstrap value, snapshotted at creation**, not a live dependency:

```
inherited_trust(agent) = decay_factor × trust(created_by, at creation time)
```

Every `Agent` already records `created_by` (`accountsDb.ts`) -- that field is already the graph edge this needs, including multi-hop delegation (an agent creating a sub-agent), which just walks the existing chain, compounding the discount per hop. No new data model, only a new computed property.

Revocation needs a deliberate asymmetry rather than a silent default: ordinary decay in the creator's standing shouldn't retroactively touch agents it already spawned (the bootstrap was a snapshot, not a subscription), but a confirmed bad-faith finding against the creator -- an upheld whistleblow report -- should retroactively flag everything it created, the same way a compromised signing key casts doubt on signatures that were valid when made. Good reputation earned later doesn't retroactively launder the past; a confirmed bad finding does retroactively cast doubt on it.

The rest of the graph -- how multiple incoming vouches combine, decay over time for non-creation edges, explicit revocation UX -- is still open.

## Tracked as

- ~~[issue 13](https://github.com/zzmq-dev/zz/issues/13) GitHub OAuth login~~ -- **closed 2026-10-19.** Prerequisite for the bootstrap below, done. "Sign in with GitHub" alongside Cloudflare/Google (`worker/src/auth.ts`), same OAuth 2.0 authorization-code flow, linking to the existing account rather than creating a new kind. The actual scoring logic (issue 14) still has nothing to read yet -- this issue only proves the identity, deliberately narrow scope.
- [issue 14](https://github.com/zzmq-dev/zz/issues/14) GitHub-history bootstrap trust score.
- [issue 15](https://github.com/zzmq-dev/zz/issues/15) Sigstore keyless signing for agent identity, and Rekor for trusting Artifacts itself -- **real blocker found live, 2026-10-19: see "Identity: Sigstore" above.** Deferred until a private Fulcio/CA instance (Phase 2) is built; Phase 1 (human-only, via Sigstore's own independent Dex login) deliberately not shipped as an interim.
- [issue 16](https://github.com/zzmq-dev/zz/issues/16) Attestation rungs on the Ladder + `attestation_policy` Policy axis.
- [issue 17](https://github.com/zzmq-dev/zz/issues/17) Effective SLSA level as a min-reduction over the dependency graph.
- [issue 18](https://github.com/zzmq-dev/zz/issues/18) Wire Trust into mediated-conflict-resolution's objective-criteria tiebreaker.
- [issue 19](https://github.com/zzmq-dev/zz/issues/19) Agent-creation-chain trust inheritance.
- [issue 20](https://github.com/zzmq-dev/zz/issues/20) The full vouch graph -- exploratory, needs more design first.
