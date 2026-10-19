---
layout: docs
title: "Spec: did:zz method specification (draft)"
description: "The formal resolution/cryptographic protocol detail Design: did:zz named as future work -- DID syntax, the signed operation log, key rotation and recovery, guardianship operations, and directory resolution."
---
# Spec: did:zz method specification (draft)

**Status: first draft, not implemented, not submitted anywhere.** [Design: did:zz](/docs/did-zz/) is the rationale-and-shape document this spec makes concrete -- read that first if you haven't; it explains *why* each choice below was made, not just what it is. This page is the part that doc explicitly deferred: "full formal resolution/cryptographic protocol detail." Modeled closely on [`did:plc`](https://github.com/did-method-plc/did-method-plc)'s own method specification -- a real, proven, 40-million-identifier-scale design for the exact same core problem (a self-authenticating, directory-resolved DID with key rotation) -- adopted wherever it already solves something `did:zz` also needs, extended only where `did:zz` genuinely differs: human-chosen names instead of hash-derived identifiers, and guardianship as a first-class operation set `did:plc` has no equivalent of at all.

## 1. Identifier syntax

```
did-zz-identifier = "did:zz:" name
name              = 3*32(ALPHA / DIGIT / "-")
                    ; lowercase only; must start and end with ALPHA/DIGIT,
                    ; not "-"; no consecutive "--"
```

Examples: `did:zz:fred`, `did:zz:dev1`, `did:zz:northwind-ops`.

Unlike `did:plc:ewvi7nxzyoun6zhxrhs64oiz`, the identifier is never hash-derived -- it's the self-chosen, globally-unique name itself (see [Design: did:zz](/docs/did-zz/) for why this is deliberate, not a simplification taken for convenience). This has one real consequence `did:plc` never has to deal with: **names can collide at proposal time**, so creation needs a real negotiation step (§3) that a hash-derived identifier never needs. It also means a name, once taken, is taken permanently -- there is no namespace reclamation, including after deactivation (§7), for the same reason a real person's old username shouldn't become available for someone else to impersonate them with later.

## 2. DID Document shape

Resolving `did:zz:fred` returns an ordinary [W3C DID Core](https://www.w3.org/TR/did-core/) document:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:zz:fred",
  "verificationMethod": [
    { "id": "did:zz:fred#key-1", "type": "Multikey", "controller": "did:zz:fred", "publicKeyMultibase": "z..." }
  ],
  "authentication": ["did:zz:fred#key-1"],
  "assertionMethod": ["did:zz:fred#key-1"],
  "service": [
    { "id": "did:zz:fred#zz", "type": "ZzAccount", "serviceEndpoint": "https://zzmq.dev" }
  ],
  "alsoKnownAs": []
}
```

Nothing in this document's own schema distinguishes a human-controlled identity from an agent-controlled one -- requirement 1 from the design doc, enforced structurally, not by convention. `rotationKeys`, `guardians`, and `lineage` (below) are **not** part of the presented DID Document, the same way `did:plc`'s own `rotationKeys` are omitted from its presented document -- they're method-internal state, needed to *produce* the document, not part of the document itself.

## 3. The operation log

Every `did:zz` identity is defined by an append-only, hash-chained, signed log of operations -- the actual source of truth; the DID Document above is always *derived* from replaying this log, never stored directly. Directly adopting `did:plc`'s own model here: each operation (except genesis) names the CID of the operation immediately before it (`prev`), so the log forms a verifiable chain, and the DID itself is derived from the genesis operation's own hash (§3.1) -- not assigned by the directory, so the directory cannot forge a DID's own history even though it's the trusted party resolving it (same trust model `did:plc` already states plainly: the directory is trusted to *order* operations and prevent denial of service, not to *forge* them -- the log is self-certifying).

Serialization, hashing, and signing follow `did:plc` directly, unchanged: operations are DAG-CBOR encoded, signed with ECDSA (low-S form, base64url-encoded), and `prev` references use CIDv1 (base32 multibase, dag-cbor codec, sha-256 multihash). No reason to invent a second scheme for a problem `did:plc` already solved at real scale.

### 3.1 `zz_create` (genesis)

```json
{
  "type": "zz_create",
  "name": "fred",
  "rotationKeys": ["did:key:z6Mk..."],
  "verificationMethods": { "key-1": "did:key:z6Mk..." },
  "services": { "zz": { "type": "ZzAccount", "endpoint": "https://zzmq.dev" } },
  "lineage": null,
  "guardians": [],
  "prev": null,
  "sig": "..."
}
```

`did:zz:<name>` is only valid once this operation is accepted by the directory (§6) -- name uniqueness is checked and reserved atomically at this step, not before it (§3, name negotiation is a client-side convenience against a read endpoint; this write is the real, atomic claim).

- **`lineage`** (new, no `did:plc` equivalent): `null` for an identity with no creator (an ordinary human's own first identity), or a Verifiable Credential issued by the creating DID, recording `{issuer: <creator's DID>, subject: <this DID>, createdAt}`. Permanent historical fact once set -- no operation in this spec ever modifies an existing `lineage` field. This is the one piece of state a later `zz_rotate` (§3.2) explicitly may never touch.
- **`guardians`** (new, no `did:plc` equivalent): the initial guardian set. Defaults to `[<creator's DID>]` when `lineage` is set (a newly-created agent starts under its creator's guardianship, matching "guardianship starts matching the creator" from the design doc) and `[]` for a human's own identity (a human is nobody's ward from the start -- guardianship as designed here is specifically the agent-oversight relationship, not applied to a human identity at all). `guardians` is mutable from here on, independent of `lineage`, via §3.3/§3.4.
- **Who holds `rotationKeys` for a brand-new agent**: the agent itself has no independent human behind it to generate and safeguard a keypair. In practice, the initial `rotationKeys` entry is generated by whichever identity is creating the agent (the same identity named in `lineage`), on the new agent's behalf, at creation time -- structurally identical to a parent holding a minor's own documents until the minor can hold them directly. This is **not** a loophole making lineage and guardianship the same thing again: the creator holding the *initial* key is a practical bootstrapping fact; `guardians` (above) is the real, intentional, transferable authority relationship, and the two can and do diverge immediately after creation (transfer guardianship once, the original creator's held key becomes irrelevant to anything but the permanent `lineage` record).

### 3.2 `zz_rotate` (update)

Identical in shape and purpose to `did:plc`'s own regular operation: a signed operation naming the full new state of `rotationKeys`/`verificationMethods`/`services`/`alsoKnownAs`, with `prev` pointing at the latest valid operation CID. Used for ordinary key rotation and service/endpoint changes. Must be signed by a current rotation key with sufficient authority (§4) -- never changes `lineage` or `guardians`, which have their own dedicated operations below specifically so a routine key rotation can never, even by a bug, accidentally touch either.

### 3.3 `zz_guardian_transfer`

```json
{
  "type": "zz_guardian_transfer",
  "outgoing": ["did:zz:troy"],
  "incoming": ["did:zz:caleb"],
  "prev": "bafyrei...",
  "sig": { "outgoing": "...", "incoming": "..." }
}
```

The one operation type in this spec requiring **two** signatures, from two different, named parties -- directly implementing "a credential co-signed by the outgoing guardian's relinquishment and the incoming guardian's acceptance, both required" from the design doc. `outgoing` must be a non-empty subset of the current guardian set; `incoming` becomes the new guardian set (wholesale replacement, not an add/remove delta -- a co-guardianship of three transferring to a co-guardianship of two-of-the-original-plus-one-new is expressed as one operation naming the complete new set, not three separate edits). An empty `incoming` is invalid here -- that's §3.4, a different operation, kept separate so "is anyone relinquishing" and "is this identity becoming fully autonomous" are never ambiguous from the operation type alone.

### 3.4 `zz_guardian_relinquish`

```json
{ "type": "zz_guardian_relinquish", "prev": "bafyrei...", "sig": "..." }
```

Sets `guardians` to `[]`. The mechanical expression of "agents working with people, not just for them" -- an agent reaching full, unattenuated standing. Requires a current guardian's signature (not the identity's own -- see §9, this is explicitly left open rather than guessed at: whether an identity can relinquish its *own* guardianship unilaterally, versus needing its guardian's sign-off, changes who's actually making the autonomy determination, and this draft doesn't resolve it). Once `guardians` is `[]`, only `zz_rotate` (self-signed by the identity's own current rotation key) and a future `zz_guardian_transfer` re-establishing a guardian (§9) remain available -- there is no operation in this draft for re-entering guardianship from zero once relinquished, which is itself an open question, not a settled permanent-exile rule.

### 3.5 `zz_tombstone` (deactivate)

Identical to `did:plc`: `{type: "zz_tombstone", prev, sig}`, signed by a current rotation key. Deactivates the DID -- resolution still returns the full historical log (§7), but no new operations are accepted afterward except a recovery nullification (§4) within the recovery window.

## 4. Key rotation authority and recovery

Directly adopted from `did:plc`: `rotationKeys` is an ordered list, descending authority. Any key in the list may sign a `zz_rotate` or `zz_tombstone`; a **higher-authority key may nullify operations signed by a lower-authority one**, within a bounded recovery window (`did:plc` uses 72 hours; this draft proposes the same as a starting point, not a researched-from-scratch value), by submitting a new operation whose `prev` points to an earlier valid CID than the operation(s) being superseded. This is the account-recovery mechanism: a compromised lower-authority key's damage is reversible by a higher-authority one, for a bounded time, the same safety property `did:plc` already proves out at scale.

For a managed agent specifically, "the higher-authority key" in practice is usually held by (or accessible to) the current guardian set, not the agent's own working key -- guardianship (§3.3/§3.4) and rotation-key authority (this section) are separate mechanisms that compose, not the same thing: a guardian doesn't need to hold a rotation key at all to meaningfully guard (the committee-decision mechanics the design doc describes could gate a guardian-initiated recovery through the existing Vote machinery instead of requiring the guardian literally hold key material), but the common, simple case is that guardianship and rotation-key custody travel together.

## 5. Directory resolution protocol

`zz` operates the directory initially (§6 of [Design: did:zz](/docs/did-zz/#the-shape-of-did-zz): "consistent with zz already being the trusted account/token authority today"). Endpoints, directly modeled on `did:plc`'s own:

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/.well-known/did/zz/<name>` | The current, derived DID Document (§2) |
| `GET` | `/.well-known/did/zz/<name>/log/audit` | The full, timestamped operation log |
| `GET` | `/.well-known/did/zz/<name>/data` | The current internal state (incl. `guardians`/`lineage`, not just the presented document) |
| `POST` | `/.well-known/did/zz/<name>/operations` | Submits one new signed operation |

Full validation of a resolved document requires replaying the entire audit log from genesis -- checking the genesis operation's own hash matches the DID, verifying every operation's signature against whichever keys had authority *at that point in the log* (not the current key set), and applying nullification rules (§4) -- directly the same validation `did:plc` itself requires and for the same reason: the directory's own say-so is never the root of trust, the self-certifying log is.

## 6. Name negotiation (creation only)

Because identifiers are human-chosen (§1), unlike `did:plc`'s hash-derived ones, creating a new identity needs a real negotiation step `did:plc` has no equivalent of:

1. Client proposes a `name`.
2. Directory checks global uniqueness against every existing (including deactivated -- §1) `did:zz:<name>`.
3. If taken, the directory suggests alternatives (the same shape most platforms already use for picking a human username, applied here to an agent choosing its own); client may retry with a different name.
4. Once a free name is settled, the client submits the actual `zz_create` operation (§3.1) -- which re-checks uniqueness atomically at write time, since another creation could have raced and claimed the name between steps 2 and 4.

## 7. Deactivation and data permanence

Directly adopted from `did:plc`: the full operation log remains permanently, publicly resolvable even after `zz_tombstone` -- deactivation stops an identity from acting, it does not erase its history, for the same reason nothing else in this project's own Lane history is ever deleted either (see [#27](https://github.com/zzmq-dev/zz/issues/27)). A name is never reclaimed into the available pool after deactivation (§1).

## 8. Security and privacy considerations

Adopted directly from `did:plc`, unchanged in substance:

- **Trust model**: the directory is trusted to order operations and resist denial-of-service against the log; it is not trusted to forge history, since the log is self-certifying and independently replayable by anyone.
- **Data permanence**: the full log, including every past `service`/`alsoKnownAs` value, stays public forever (§7) -- don't put anything in those fields that shouldn't be permanently, publicly linkable to this identity.
- **Key reuse**: reusing a rotation or verification key across more than one `did:zz` identity can leak a relationship between them that was never meant to be public.

New to `did:zz`, with no `did:plc` equivalent to adopt from:

- **Guardian key compromise**: a compromised guardian key could attempt a malicious `zz_guardian_transfer` -- mitigated, not eliminated, by the two-signature requirement (§3.3): a single compromised outgoing-guardian key cannot transfer guardianship without a cooperating (or separately compromised) incoming-guardian signature too. A compromised *sole* guardian of an agent with no co-guardians is a real, unmitigated risk in this draft -- worth flagging rather than glossing over; encouraging co-guardianship for anything that matters is a policy recommendation, not a protocol-level guarantee here.
- **Name squatting**: because names are permanent and human-chosen (§1, §7), claiming a name someone else would obviously want, ahead of them, is possible in principle. This draft doesn't propose a mitigation (a reservation period, a dispute process) -- flagged as unresolved, not solved by omission.
- **Sybil creation**: nothing in this method limits how many `did:zz` identities one party can create. This is intentional, not an oversight -- the same reasoning [Trust model](/docs/trust-model/) already applies: standing is earned by Trust score and lineage/guardianship history, never gated at identity-creation time, since gating creation is exactly the kind of categorical, up-front judgment this project's own principles argue against.

## 9. What this draft still leaves open

- Whether `zz_guardian_relinquish` (§3.4) can ever be self-initiated by the identity being relinquished, versus always requiring a current guardian's own signature -- genuinely unresolved, not an oversight, since it decides *who* gets to call an agent ready for full autonomy.
- Whether a `guardians: []` identity can ever re-enter guardianship later (a new guardian being established from zero), and if so, who may initiate that and what it requires.
- The exact recovery window duration (this draft proposes `did:plc`'s own 72 hours as a starting point, not a value arrived at independently).
- Rate limits, field size constraints, and DoS-resistance mechanics at the directory -- `did:plc`'s own spec lists these as its own future work too, not a gap unique to this draft.
- Multi-operator directory federation (one `zz`-operated directory today, same open question [Design: did:zz](/docs/did-zz/#what-s-still-open) already names, not resolved further here).
- Interoperability with an external, pre-existing DID (someone already holding a `did:plc` from Bluesky, say) -- not addressed in this draft either.

## Tracked as

- [#23](https://github.com/zzmq-dev/zz/issues/23) Design and implement did:zz -- this page is the "full formal resolution/cryptographic protocol detail" that issue's own scope named as further-out work, now drafted. Still not implemented; see [Design: did:zz](/docs/did-zz/) for the rationale this spec makes concrete.
