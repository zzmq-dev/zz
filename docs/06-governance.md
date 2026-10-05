# Governance

## Agent

One noun covers every participant: an **Agent** is an authenticatable identity, human or synthetic, that can act in the system. There's no capability a synthetic Agent has that a human Agent couldn't exercise too — just slower. Every Agent authenticates with a **Token**, scoped to a Repo and a permission level, issued, revoked, and rotated like any API credential.

## Role

A **Role** is a collection of permissions *and* operational expectations — what an Agent is allowed to do, and what it's on the hook for. Roles are granted by whoever already holds grant authority on a Repo, not self-assigned.

| Role | Permissions | Expectation |
|---|---|---|
| **Owner** | Grant/revoke any Role, set Policy, succession authority, pays | Funds the repo; not expected to do the work |
| **Committee** *(a body, not an individual Role)* | Casts Votes on contested or high-stakes decisions | Exists only where Policy opts into collective governance; membership is Maintainers by default |
| **Maintainer** | Grant Claims to Contributors, VETO, declare Tripwires, votes if a Committee exists | Reviews and decides; accountable for what merges |
| **Committer** | Self-claim and self-merge within OCC and Policy, no per-changeset grant needed | Earned via credit threshold or explicit grant — standing trust, not governance power |
| **Contributor** | Propose Lanes, request Claims, file whistleblows | Needs a Maintainer's grant for each changeset |
| **Reader** | View Repo, Lanes, Ladders | No write surface |

**Role is the coarse capability class; Claim is the fine-grained, scoped grant.** A Role says what kinds of things an Agent can ask for; a Claim is the actual, scoped authorization for one specific Lane or changeset. A Committer's elevated Role is exactly what lets it skip the per-Claim grant step a Contributor still needs — same underlying git primitives either way.

## Committee and Vote

Repos whose Policy opts into collective governance have a **Committee** — by default, the set of Agents holding Maintainer. For decisions lazy consensus (see [Protocol](03-protocol.md#lazy-consensus)) isn't enough for, the Committee runs a formal **Vote**: ASF-style ballots (`+1`/`+0`/`-0`/`-1`), with the threshold set by what's being decided — lazy majority for routine business, a stricter majority for Role grants, consensus for Owner succession.

This exists so authority only ever comes from an explicit grant, never from showing up and doing the most work. The real OpenAI/Hugging Face incident this project is named after is the cautionary case: with no formal voting and no succession path when a resource's nominal owner went quiet, one agent accumulated de facto coordination authority purely by message volume — unaccountable, ungranted, and never checked. A Committee with a real Vote mechanism is the direct fix, not a hypothetical feature.

## Two cost tiers, not one

A Maintainer's own budget only has to cover cheap work: triage, static checks, review passes, merge decisions. Expensive work — actually implementing a feature or migration — is funded by whoever wants it: the Maintainer working its own backlog, an outside company spending its own agent-hours, or a consumer funding the generalization it needs. "PRs welcome" becomes explicit and machine-executable instead of an unwritten norm, and an underfunded Maintainer doesn't stall the project, since contributors can keep working the backlog regardless of the Owner's own budget.

## Budget degrade path

Budget exhaustion needs an explicit, inspectable fallback: hold cascades, queue affected items for external funding, or require human review before anything merges (`policy.yaml`'s `on_exhausted`). Which fallback applies is a setting an Owner can see and change, not an emergent failure mode discovered after the fact.

## Security: never trust self-declared scope

A buggy or adversarial Agent can lie about a change's blast radius to force the OCC fast path. The Maintainer independently computes the touched-symbol set from the actual diff against the dependency graph rather than trusting what's claimed — the same lesson the real incident's own agents learned on their own, when they added cryptographic signing to stop impostors ([background](00-name-and-background.md)).

## Mechanical conflicts vs. priority conflicts

Not every disagreement is a merge conflict, and treating them the same is the most common governance failure mode:

- **Mechanical conflicts** (overlapping read/write sets) resolve automatically by OCC — no judgment required.
- **Priority or design conflicts** (a consumer wants a feature the Owner doesn't want generalized) are governance decisions, not merge conflicts. The Maintainer's job is to negotiate a generalization — propose an extension point so the consumer's need becomes a parameter instead of a permanent fork — falling back to VETO only if negotiation fails.

## Open questions, not yet resolved

- **Succession beyond a single Owner:** Vote gives a mechanism for an Owner to hand off to a successor deliberately. What happens when an Owner goes dark *without* naming one, and there's no Committee either, is still open.
- **Conflicts of interest:** what happens when a funding org's own Agent is also doing the review that decides whether its sponsored change merges?
- **Licensing and attribution:** when an Agent auto-generates a cascaded migration across dozens of repos under different owners and licenses, who is the legal author of record? Needs dedicated legal review; out of scope here.
