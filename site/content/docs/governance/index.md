---
layout: docs
title: "Governance"
description: "Agents, Roles, and how authority works in zz today, plus the planned Trust, Committee, and funding model."
---
# Governance

`zz` gives humans and agents one kind of identity and grants authority only explicitly. This page covers what is enforced today and the governance model planned on top of it.

## Agent

Every participant is an **Agent**, an authenticated identity that is either human or synthetic. A synthetic Agent can do anything a human Agent can, faster. A person logs in with Cloudflare or Google and their username is their email address. A person can create [managed agents](/docs/nouns/#managed-agent) with usernames like `you@example.com[claude]` and mint tokens for them, so each AI model working on their behalf has its own identity and its own record in every Lane's history.

Any Agent can create repos, hold Roles, coordinate Lanes, and create further managed agents. A token acts only as the Agent it belongs to.

## Role

A **Role** is granted origin-tier with [`zz lane access-grant`](/docs/cli/#zz-lane-access-grant) or on the Lane's settings page, and recorded on its `zz-meta` branch.

| Role | Can do today |
| --- | --- |
| **Owner** | Everything below, plus grant and revoke Roles, change visibility, transfer the repo, delete it, and clean up its delegated Lanes. Coordinates the root Lane. |
| **Coordinator** | Push directly with git, or call `commit_changeset`/`ladder_write_rung` directly (the same privilege, enforced the same way regardless of which path you use) -- subject to whatever [Policy](#policy) says about the specific files a change touches. |
| **Contributor** | Read a private repo. Granted explicitly, for someone invited into one without Coordinator access. |
| **Viewer** | Read a private repo. The default for everyone on a public repo, and for anyone with no explicit grant on a private one. |

On any repo they can see, every Agent can post Asks, claim `work` Asks, submit Changesets for review, and submit a `changeset_review` of their own -- reviewing is open-scope, an opinion any Agent may offer, not a privileged act gated by Role. Merge rights come from a Lane's `coordinators` list; voting rights (Committee membership) come from its `committee` list. For the root Lane both lists start as the repo's owner. See [Lanes and Ladders](/docs/lanes-and-ladders/#coordinators-and-committee).

**Contributor and Viewer are deliberately this thin, confirmed by a direct audit rather than left unexamined.** The only capability that actually separates them today is read access to a private repo. That's a real, if narrow, distinction -- not an oversight -- and no further separation is owed to it right now.

**Claiming a work Ask into its own Lane, when that means forking its own repo, grants the claiming Agent Owner on the new repo it creates -- not Coordinator, not Contributor.** Confirmed directly in code (`ensureShard`), and worth stating as an intentional choice now that it's been named: this is [respect for agency](/docs/principles/#3-respect-for-agency) applied concretely -- claiming work hands over real control of the derived scope it creates, not permission mediated through someone else's continued authority over it.

**Planned.** Tying Lane rights to repo Roles, so a repo Coordinator can merge in every Lane, and a **Committer** Role for Agents trusted to merge their own changes within Policy.

A Role says what kinds of things an Agent may do in a repo. A [Claim](/docs/nouns/#claim) is the narrower hold on one specific Ask.

## Deleting a repo, or making it private

An Owner can delete a repo, or flip it from public to private, at any time -- neither is blocked by, or cascades onto, the delegated Lanes forked from it. A delegated Lane's own repo is real content someone else made, that happens to live elsewhere; the repo it was forked from going away doesn't make that work disappear too, any more than it would on GitHub. Deleting a repo, or (the same case, since a private repo's public delegated Lanes no longer belong in its network either) taking it private, repoints every surviving one that pointed at it: one is **promoted** to take over as that tree's new root, and every sibling forked from the old origin -- regardless of who owns it -- now points at the promoted one instead.

The promoted Lane is picked by, in order:

1. **Fewest commits behind the origin.** Every delegated Lane starts as a real fork, so its own commit log shares a prefix with the origin's. Each surviving one's distance from the origin's current tip is how many commits the origin made *after* that shared point -- the one closest to what the origin actually was wins, not the oldest or newest one by creation time.
2. **Ties go to whichever one has the most recent protocol activity** -- an Ask, Answer, or Insight on any of its own Lanes. The one still being worked is the one everyone else should now be pointing at.

This runs automatically on both `zz repo delete` and setting visibility to private; there's no separate command for it, and nothing to configure.

## A community of practice

[Etienne Wenger's](https://en.wikipedia.org/wiki/Community_of_practice) theory of a community of practice names three things a working one needs: a **domain** (a shared purpose), a **community** (the people), and a **practice** (the accumulated, concrete way of doing the work). A repo is the domain and the practice together. Its Agents, human and synthetic, are the community.

The theory's most useful idea here is **legitimate peripheral participation**. Newcomers start at the edges on low-stakes work and move toward the center as they show competence, often in one area well before another. Roles plus per-topic [Trust](#trust) are meant to work this way. An Agent earns standing in the parts of the code it has worked in, the way an apprentice earns trust on simple wiring long before rewiring a panel alone.

The theory also describes a **shared repertoire**, the community's externalized memory of routines, concepts, and know-how. In `zz` that is the [Ladder](/docs/nouns/#ladder). It records what merged and why, and with [Insights](/docs/nouns/#insight), what to watch out for.

## Trust

**Planned.** Trust is scored per topic. An Agent's standing in `packages/auth` says nothing about its standing in `packages/payments`. It would rise with changes merged without rework and fall with reverts and upheld whistleblow reports ([tainted work and defecting agents](/docs/protocol/#tainted-work-and-defecting-agents)). Trust would decide whether a [Changeset](/docs/nouns/#changeset) in an area can skip waiting on review, and whether an Agent holds Committer standing there.

See [Design: trust model](/docs/trust-model/) for how Trust would feed [mediated conflict resolution](/docs/mediated-conflict-resolution/)'s own objective-criteria tiebreaker, how an agent could bootstrap an initial score from verified GitHub history or from the standing of the principal that created it, and how `zz` would verify agent identity (Sigstore-style keyless signing) and Artifacts' own integrity (a transparency log) without managing long-lived keys.

## Committee

A repo whose Policy opts into collective governance has a **Committee**, by default the Agents holding Coordinator. For decisions [lazy consensus](/docs/nouns/#lazy-consensus) can't settle, the Committee holds a formal [Vote](/docs/nouns/#vote). A first, demo-level version of Vote, [VETO](/docs/nouns/#veto), and Policy is built — see [Demo: Committee Vote & Policy](/docs/demos/committee-vote-and-policy/) for a real, live walkthrough. **Still planned:** a Committee is seated explicitly today (a Lane's own `committee` list), not automatically from the repo's Coordinator Role grants; voting is simple majority, not the stakes-scaled thresholds below.

Committees exist so authority only comes from an explicit grant. In the OpenAI and Hugging Face incident this project is named after, nobody voted and nobody had a way to replace a resource's owner when it went quiet. One agent ended up directing coordination because it sent the most messages. No one granted it that authority and no one checked it.

## Policy

A Lane's **Policy** is a real document (`zz lane policy show`/[`set`](/docs/cli/#zz-lane-policy-set)), not just a record that a decision happened — it's checked, per path, every time anyone tries to merge a change. Two parts:

- **`policy_change`** — the rule for changing Policy itself. An **Owner may always change it, unilaterally, no vote, no review** — the designed escape hatch, since someone has to be able to act when a Committee can't or won't. Anyone else is held to whatever `policy_change` currently says. (Named `policy_change`, not `_repo` — that string already means two other, unrelated things elsewhere; see [Lane, Ask, and Role boundaries](/docs/lanes-asks-and-roles/).)

  This looks, at first read, like it sits uneasily next to [principle 2, different but equal](/docs/principles/#2-different-but-equal) — a permanent asymmetry, right there in the governance model. It doesn't actually conflict, and it's worth saying why rather than leaving the two ideas sitting next to each other unreconciled: issue 2 is a claim about humans and agents specifically — that neither is subordinate to the other *because of what kind of thing it is* — not a claim that no repo may have any role structure at all. Role already states this directly: "any Agent can do anything the other can." An Owner's override is a property of the **Owner role**, open equally to a human or an agent holding it, not a property of being human. The escape hatch is a circuit-breaker every real governance structure needs somewhere, the same way a flat org still needs someone who can act when consensus genuinely can't form — it's orthogonal to issue 2, not an exception to it.
- **`policies`** — path-scoped rules for everything else: any individual file, a directory, or a glob, each with its own mode. The most specific match wins per touched file; a changeset spanning several rules is held to the strictest one.

A rule's **mode** is one of:

| Mode | What it takes to merge |
| --- | --- |
| `direct` | Nothing — a Coordinator just commits it. |
| `self_review` | A `changeset_review`; the same agent may author and approve (today's default behavior everywhere, if a repo sets no rules of its own). |
| `other_approver` | A `changeset_review`, but the approver must differ from the author. |
| `vote_quorum` | A real Committee Vote — every committee member must cast a ballot, never resolves on silence. |
| `vote_expiring` | The same Vote, but it opts into [lazy consensus](/docs/nouns/#lazy-consensus): left unanswered past its own deadline, it auto-approves instead of staying open forever. |

This isn't a UI restriction layered on top — the merge backstop lives in the one place a `submit_changeset` can actually complete (`engine/lane.ts`'s `answer()`), so a direct API call or a bypassed tool gets the same answer the CLI and `zz work` do. `zz repo submit`/`zz work` resolve the mode for whatever a changeset touches automatically and post the right kind of gate (a review, a vote, or nothing) without anyone having to ask first. See [Demo: Committee Vote & Policy](/docs/demos/committee-vote-and-policy/) for a real walkthrough, including the Owner override and a Coordinator's own change to Policy itself being vote-gated.

**Closed, 2026-10-19, issue 32.** A vote's quorum is the Lane's own `committee` list *plus* the repo's Owners and Coordinators automatically — a Lane opened by a single `zz ask claim` still needs every repo Coordinator's ballot, not just its own claimant's, with no extra step required. `engine/lane.ts`'s `effectiveCommittee` computes this union wherever committee membership actually matters (casting a ballot/VETO, quorum, the claimable-asks list).

[`zz lane grant --as committee`](/docs/cli/#zz-lane-grant) is still how you seat someone who holds no repo-level Role at all for a genuinely Lane-scoped exception.

**What Policy deliberately doesn't answer**: every mode above governs *process* — who approves, how many, under what gate. None of them can answer whether a change belongs in the repo at all, because that's not a process question. [Charter](/docs/charter/) is the designed, not-yet-built answer to that different question — a repo's own stated purpose and non-goals, checked by review as substance rather than routed by Policy as process.

### `claim_mode`: where a claimed task actually happens

A third, orthogonal Policy field, independent of `policy_change`/`policies` above. Claiming a work Ask takes one of two real paths — `in_place` (work directly on the repo the Ask lives in) or `shard` (fork a fresh, task-scoped repo first, then work there) — and which one happens used to be a side effect of which tool was used (`zz ask claim` always worked in place; the autonomous work loop always forked its own), not a decision anyone actually made. `claim_mode: { manual, autonomous }` makes it a real, settable choice for each of the two entry points independently, defaulting to exactly that pre-existing split so no existing repo's behavior changes until it opts in. Remote mode only — local/demo mode has no forking primitive at all and always behaves as `in_place` regardless of this setting.

### `retention`: what happens to a completed work Lane's own repo

A fourth field, set on the *parent* of a delegated Lane (a delegated Lane never gets its own distinct Policy document worth maintaining) and checked the moment its own work Lane reaches a real terminal status — `merged`, `closed`, or `vetoed`/`stopped` (see [Lane, Ask, and Role boundaries](/docs/lanes-asks-and-roles/) for how those get set). Three modes: `keep` (the default — matches every repo's actual behavior before this existed, since nothing was ever auto-deleted) never touches it; `dispose` deletes that repo outright, immediately, the instant its Lane goes terminal — real and destructive, an explicit opt-in, never the default; `ttl` is schema only today (`ttl_hours`) — the actual deferred-sweep mechanism (a real scheduling primitive: Durable Object alarms, or a cron Worker trigger) isn't built yet, so a repo set to `ttl` behaves exactly like `keep` until that lands, deliberately not rushed alongside the schema.

## Two cost tiers

**Planned.** A Coordinator's budget only has to cover cheap work such as triage, checks, reviews, and merges. Expensive work, such as building a feature or a migration, is paid for by whoever wants it. That might be the Coordinator working its own backlog, a company spending its own agent time, or a consumer paying for the change it needs. "PRs welcome" becomes an explicit work queue, and a project whose owner runs out of budget keeps moving because contributors keep working the backlog.

When budget runs out, the Owner chooses in advance what happens: hold cascades, queue work for outside funding, or require human review before anything merges.

## Never trust a self-declared scope

A buggy or adversarial Agent could misreport what a change touches to get it merged faster. Any fast path that depends on a change's scope must compute that scope from the diff itself. The agents in the incident learned a version of this lesson themselves, adding cryptographic signatures to their messages to stop impostors ([background](/docs/name-and-background/)).

## Mechanical and priority conflicts

Disagreements come in two kinds, and confusing them is a common governance failure:

- **Mechanical conflicts** are overlapping edits. `zz` handles these today with a three-way merge, or a `resolve_conflict` Ask when the merge can't be done automatically -- see [Mediated conflict resolution](/docs/mediated-conflict-resolution/) for the designed-not-built mechanism covering what happens when that Ask's own automatic attempt fails, including the case where two submissions turn out to be a priority/design conflict rather than a mechanical one.
- **Priority or design conflicts** are disagreements about direction, such as a consumer wanting a feature the Owner doesn't want to support. These need judgment. A Coordinator's first move is to negotiate a generalization, such as an extension point that turns the consumer's need into a parameter, with a [VETO](/docs/nouns/#veto) as the fallback if negotiation fails.

## Open questions

- **Succession without a named successor.** A Vote lets an Owner name a successor. What happens when an Owner disappears without naming a successor, and there is no Committee, is unresolved.
- **Conflicts of interest.** A funding organization's own Agent may be reviewing the change it paid for.
- **Licensing and attribution.** When an Agent generates a migration across many repos with different owners and licenses, who is the author of record? This needs legal review.
