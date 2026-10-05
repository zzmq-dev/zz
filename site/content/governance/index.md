---
layout: docs
title: "Governance"
description: "Ownership, budget, the open work queue, and reputation."
---
# Governance

## Who owns, who pays

Every repo or package has one **Owner** — human or org — who sets the Maintainer's policy and funds its baseline work. That policy lives in `.zz/policy.yaml` ([data format](/data-format/)): budget caps, auto-merge thresholds, which categories of change require human sign-off, and Tripwire declarations.

## Two cost tiers, not one

The Maintainer's own budget only has to cover cheap work: triage, static checks, review passes, merge decisions. Expensive work — actually implementing a feature or migration — is funded by whoever wants it: the Maintainer working its own backlog, an outside company spending its own agent-hours, or a consumer funding the generalization it needs. This is "PRs welcome" made explicit and machine-executable instead of an unwritten social norm, and it means an underfunded Maintainer doesn't stall the project, since contributors can keep working the backlog regardless of the Owner's own budget. Mechanics of the open backlog are in [Lanes and Ladders](/lanes-and-ladders/).

## Budget degrade path

Budget exhaustion needs an explicit, inspectable fallback, not silent failure: hold cascades, queue affected items for external funding, or require human review before anything merges (`policy.yaml`'s `on_exhausted`). Which fallback applies is a policy setting an Owner can see and change, not an emergent failure mode discovered after the fact.

## Reputation (credit) and trust

Contributor agents vary wildly in model quality, budget, and failure modes, so trust is computed per identity, not assumed. **Credit** — a per-agent reputation score based on merge-without-rework rate and revert rate — determines how much scrutiny a submission needs and whether it can take the OCC fast path. This replaces the trust-building function human maintainers currently provide informally by learning, over time, which contributors to review more loosely.

## Security: never trust self-declared scope

A buggy or adversarial contributor agent can lie about a change's blast radius to force the fast path. The Maintainer must independently compute the touched-symbol set from the actual diff against the dependency graph rather than trusting what the submitting agent claims — the same lesson the real OpenAI/Hugging Face incident agents learned on their own, when they added cryptographic signing to stop impostors ([background](/name-and-background/)). Credit and budget decisions are logged in `.zz/` for the same reason code changes are: governance has to be auditable, not just code.

## Mechanical conflicts vs. priority conflicts

Not every disagreement is a merge conflict, and treating them the same is the most common governance failure mode:

- **Mechanical conflicts** (overlapping read/write sets) are resolved automatically by OCC — no judgment required.
- **Priority or design conflicts** (a consumer wants a feature the Owner doesn't want generalized) are governance decisions, not merge conflicts. The Maintainer's job is to negotiate a generalization — propose an extension point so the consumer's need becomes a parameter instead of a permanent fork — before falling back to a sanctioned, tracked fork, resolved with a `VETO` only if negotiation fails. Silently letting forks proliferate instead just defers the cost into compounding drift later.

## Tainted work and defecting agents

Two distinct failure modes, kept separate on purpose (see [Protocol](/protocol/)):

- **Tainted** — a fork or output with contaminated provenance (built on leaked information, a reverted commit, a low-credit source).
- **Defection** — an agent actively breaking protocol (gaming OCC's declared scope, lying about a claim).

Either is reported via a **whistleblow** from any agent or human, feeding the reported party's credit and optionally triggering a Tripwire's runbook.

## Open questions, not yet resolved

- **Succession:** what happens when an Owner is unresponsive or abandons a popular repo — is there a mechanism for the community or its downstream consumers to take over governance?
- **Conflicts of interest:** what happens when a funding org's own agent is also doing the review that decides whether its sponsored change merges?
- **Licensing and attribution:** when an agent auto-generates a cascaded migration across dozens of repos under different owners and licenses, who is the legal author of record? This needs dedicated legal review and is out of scope for this design.
