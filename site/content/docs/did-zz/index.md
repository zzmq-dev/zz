---
layout: docs
title: "zz's identity layer: did:guardian"
description: "zz's agent/human identity design grew into a general-purpose DID method, now its own project -- what it is, why it moved out, and how zz adopts it."
---
# zz's identity layer: did:guardian

**Status: adopted externally, not yet implemented in zz.** What started here as `did:zz` -- a DID method scoped to zz's own agent/human identity needs -- converged, through design work, into something genuinely general-purpose: a method for *any* identity that may need another party's custodial oversight (key recovery, revocation, transfer), with group guardianship as a first-class, cryptographically-enforced relationship. That's no longer a zz-specific concern, so it's no longer a zz-specific spec.

**The full method specification now lives at [did-method-guardian/did-method-guardian](https://github.com/did-method-guardian/did-method-guardian)** (website: [guardianspec.org](https://guardianspec.org), once deployed), not here -- read it there, not this page, for anything protocol-level. This page stays only to record zz's own adoption decision and point newcomers to the right place, rather than duplicating a spec that will drift.

## What changed, and why

Everything originally designed under the `did:zz` name carried forward, refined through direct scrutiny of the exact questions that matter most for an identity method meant to last: can one party impersonate another via a forged relationship claim (both directions, closed with per-party consent signatures, not unilateral assertion); what happens when a guardian rotates their own keys (nothing -- guardian references resolve live, never a frozen snapshot); how does group guardianship actually reach consensus (configurable M-of-N thresholds, strict majority to preserve quorum intersection, no silent forks). A few things changed shape along the way:

- **`lineage` (a separate "creator" record, distinct from guardianship) was cut entirely.** A full, append-only guardian-history log already gives you "who was the original guardian" permanently, for free -- genesis is immutable and hash-chained into the identifier itself. Tracking it twice was imported complexity from the human-family-guardianship analogy, not an identified protocol need.
- **The identifier became domain-qualified**, `did:guardian:<name>:<domain-labels>` -- name-first, reading left to right like an email address, rather than zz's own originally-flat `did:zz:<name>`. This also properly supports the same person holding genuinely separate, independently-governed identities under different registrars (a corporate identity under a board's guardianship, a personal one under none at all), which flat names couldn't express.
- **The method itself was renamed and de-zz'd.** `did:guardian` -- no "agent"/"human" language anywhere in the method; the relationship is `guardian`/`ward` throughout, equally applicable to a human managing another human's identity, a human managing an agent's, or anything else. zz's own vocabulary (`agent`, `managed agent`) stays zz's own, mapped onto `ward` at the boundary, not baked into the method.

## What this means for zz

zz's identity layer will be built against `did:guardian` once that implementation work is scoped -- not yet started, same as `did:zz`'s own implementation was never started while design was still settling. The issues this superseded or informs:

- [#23](https://github.com/zzmq-dev/zz/issues/23) Design and implement a DID method -- updated to point at the new repo; this is where zz's own adoption/implementation work will be tracked going forward.
- [#15](https://github.com/zzmq-dev/zz/issues/15) Sigstore keyless signing for agent identity -- unchanged in its own design, now sitting on top of `did:guardian` identities instead of raw OAuth accounts, same as it would have sat on `did:zz`.
- [#19](https://github.com/zzmq-dev/zz/issues/19) Agent-creation-chain trust inheritance -- the `created_by` mechanism it's built on becomes the same relationship a guardian-establishment operation records in the new method.
- [#21](https://github.com/zzmq-dev/zz/issues/21) Agent self-naming -- already shipped as an interim, pre-`did:guardian` mechanism; flagged there as needing revisiting once this lands.
- [#26](https://github.com/zzmq-dev/zz/issues/26) Retire `computeUsername`'s bracket-chained identity scheme -- blocked on this, same as it was blocked on `did:zz`.
