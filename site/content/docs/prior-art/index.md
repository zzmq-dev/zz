---
layout: docs
title: "Prior art"
description: "What already exists, and what zz borrows from it or does differently."
---
# Prior art

What already exists, and what `zz` borrows from it or does differently.

## Multi-agent task allocation

The **Contract Net Protocol** (Reid G. Smith, 1980) is a direct precedent for `ASK`/`ANSWER`. A manager agent broadcasts a task announcement, other agents bid, and the manager awards a contract to one. A `work` Ask that any eligible agent can claim follows a well-studied pattern more than forty years old.

**Blackboard systems** (Hearsay-II and the broader blackboard architecture) are the ancestor of a [Lane](/docs/nouns/#lane) as a shared surface that specialist agents post to and read from, each contributing when it can help. The pattern also explains why the agents in [the incident this project is named after](/docs/name-and-background/) converged on a message board unprompted. They rediscovered a well-known architecture.

Sources: [Smith, "The Contract Net Protocol," 1980](https://www.reidgsmith.com/The_Contract_Net_Protocol_Dec-1980.pdf) · [Contract Net Protocol overview](https://en.wikipedia.org/wiki/Contract_Net_Protocol)

## Production code review

**Gerrit** has a close analog to a [Changeset](/docs/nouns/#changeset). A Gerrit "Change" is the reviewable unit, reviewers score it on labeled categories, and it becomes submittable once it clears its labels with no **veto vote** in any category, Gerrit's own term. That's independent, production validation of the Changeset and `VETO` shapes.

Source: [Gerrit submit requirements](https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html)

## Merge queues

Bors and GitHub's Merge Queue handle concurrent changes by **serializing** them. Each change is tested against the current base one at a time and merged if it passes. `zz`'s planned fast path takes a different approach, [optimistic concurrency control](https://en.wikipedia.org/wiki/Optimistic_concurrency_control) (OCC). Changes that touch disjoint parts of the code merge in parallel without queueing, which is the throughput agent-scale work needs.

OCC has a limit. It proves only the absence of *mechanical* conflicts, meaning overlapping symbols or lines. Two Changesets that touch separate code but break each other's behavior pass OCC and break something together. This is a *semantic* conflict, which OCC doesn't check. A queue can serve here as a periodic backstop instead of the main gate, in the form of a recurring Lane that re-validates a batch of recently merged Changesets together, run on a schedule or by a Tripwire when merges in one area get dense, with `ROLL` as the recovery path if it fails. High-contention files need no special handling. A hotspot never qualifies for the fast path, so review concentrates where it belongs without serializing the rest of the repo.

Today, `zz` merges each approved Changeset with a three-way merge and posts a `resolve_conflict` Ask when one can't be merged cleanly. See [Protocol](/docs/protocol/#review-and-merge).

## Is OCC novel?

Partly. Git's merge has always been optimistic. It proceeds without locking and checks for conflicts only at merge time. Git detects conflicts by **text line**, though, which produces false positives (unrelated edits that happen to sit near each other) and false negatives (edits on different lines that are semantically incompatible merge silently). Moving conflict detection to **symbols in the dependency graph** is the move build systems like Bazel and Pants made for change-impact analysis, tracing the graph instead of diffing text. Structural, syntax-aware merging already ships in Plastic SCM's **SemanticMerge**. And the term itself is older than all of these. Kung and Robinson's 1981 paper on optimistic concurrency control describes read/write-set validation at transaction commit time in databases, structurally identical to this design, applied to rows instead of code.

What's new is combining the three ideas (optimistic merging, graph-based impact analysis, structural conflict detection) into the fast path for agent coordination, tied into Lanes, Claims, Trust, and Tripwires.

Sources: [Kung & Robinson, "On Optimistic Methods for Concurrency Control," ACM TODS 1981](https://www.eecs.harvard.edu/~htk/publication/1981-tods-kung-robinson.pdf) · [SemanticMerge intro](https://www.semanticmerge.com/semanticmerge-intro-guide)

## Mediating a conflict once OCC's fast path can't avoid one

[Mediated conflict resolution](/docs/mediated-conflict-resolution/) is what happens past OCC's own limit, above: two Changesets that do collide, where a `resolve_conflict` Ask's own automatic attempt isn't enough. The design that shipped there isn't the first one tried.

**The naive first attempt, and how it failed.** The obvious move, and the one actually taken first here, was to extend OCC's own symbol-level thinking from *detecting* a conflict into *preventing* one: have an agent declare which files or symbols it's about to touch, let peer agents see the declaration, and defer integration until every claim on a contested symbol clears -- the same idea the OCC section above already gestures at with Bazel/Pants-style dependency-graph analysis and SemanticMerge's structural diffing, just applied pre-emptively instead of at merge time. It's also not a hypothetical: **[GitTub](https://gittub.hemanthhm.workers.dev/)**, a real project on the same Cloudflare stack this one uses (Workers, Artifacts, Durable Objects), ships close to exactly this -- agents declare `targetFiles`/`targetSymbols` before generating code, so peers can detect semantic collisions before merge time.

It didn't survive two stress tests. First: two agents can declare entirely disjoint symbols -- one implements `gcd`, a different one implements `lcm`, which calls `gcd` -- and still be in real conflict if one changes a contract the other depends on. The conflict lives on a dependency edge neither declaration names, so no claim granularity catches it without locking every transitive dependency of everything anyone touches, which reintroduces the serialization cost OCC exists to avoid. Second: it only solves for code. Concurrent edits to documentation or images can conflict too, and symbol declarations have nothing to say about either. Claims in `zz` stay what they already were before this design started: a way to prevent duplicate work on the same Ask, never a conflict-prevention lock.

**What replaced it** was giving up on prevention and investing in resolution instead -- the existing Lane tree (`lane_propose`'s claimant becomes coordinator, decomposition's sibling sub-Lanes) as a hierarchy of mediators, each responsible only for reconciling its own direct children, recursing to the repo's own coordinator at the root. Media-agnostic by construction, since the trigger is just "do these two changesets conflict," which git already answers for any file type.

**Human mediation practice** shaped the mechanism itself once resolution, not prevention, was the target. Fisher, Ury & Patton's *Getting to Yes* (the Harvard Negotiation Project's principled-negotiation framework) supplies the actual moves: separate the people from the problem, focus on interests instead of positions, invent options for mutual gain before picking a side, and fall back to objective criteria rather than straining for a synthesis that isn't really there. Divorce mediation practice specifically informed the neutral-language framing (critique the changeset, never the agent) and the "future-focused, durable agreement" principle, which has a direct mechanical translation here: a resolved mediation writes an [Insight](/docs/nouns/#insight) so the same ambiguity doesn't cause the same collision twice.

**[Kialo](https://en.wikipedia.org/wiki/Kialo)** contributes structure, not resolution -- a claim with Pro/Con branches that nest into counter-considerations, which is a good shape for laying out two sides' interests and the evidence under each. Kialo itself never auto-resolves a debate to one conclusion, though; it's a human-voting and argument-mapping tool. Using its tree shape as the skeleton for an automatic bottom-up resolution is new here, not borrowed.

**[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)**, TypeSafe's "System One" model, is the mechanism that walks that tree: fast, cheap, type-safe structured decisions (`Choice`/`Score`/`Noul`, with calibrated confidence) rather than open-ended generation, a better fit for "resolve many small structured questions against shared context" than a reasoning model would be, and explicitly optional -- a repo without it configured falls back to one mediator call that picks a side or synthesizes, with its own, less-calibrated self-reported confidence driving the same escalation path.

## Governance beyond a single Owner

Four precedents inform the planned Vote, lazy consensus, and Committee model in [Governance](/docs/governance/#committee):

- **The Apache Software Foundation** uses lazy consensus (propose, and silence means assent) by default, with a formal vote only for decisions that need one. `zz`'s ballots (`+1`, `+0`, `-0`, `-1`) are ASF's.
- **Rust's RFC process and Final Comment Period** apply lazy consensus to design decisions instead of code merges. A proposal opens a public countdown and proceeds if nothing substantive blocks it.
- **The IETF's "rough consensus and running code"** is an older and more famous instance of the idea.
- **Debian's constitution** sets supermajority requirements that scale with the decision, from a simple majority for routine resolutions to higher thresholds for overriding a maintainer or amending the constitution. It's the precedent for a Vote's threshold varying with what is being decided.

For splitting coordination across several coordinators, **the Linux kernel's subsystem-maintainer tree** is the model. Each subsystem maintainer merges independently into their own tree, and the trees flow up a hierarchy to Linus. It shows the pattern scales to one of the largest codebases there is.

## Identity and trust without long-lived keys

[Trust model](/docs/trust-model/) draws on three precedents, two of them pulling in different directions on the same underlying problem.

**ASF's own key-signing parties** are the direct precedent for "a new contributor shouldn't start from zero trust" -- real, in-person PGP cross-signing among committers, building a literal web of trust. It's also the precedent this design deliberately doesn't adopt the mechanism of: long-lived key custody at the scale distributed agents would need is exactly the problem the industry moved away from PGP-style webs of trust to solve.

**[Sigstore](https://www.sigstore.dev/)** (`cosign` + Fulcio + Rekor) is what replaced it: keyless signing, where an ephemeral certificate gets bound to an existing OIDC identity and expires in minutes, and the signing *event* -- not a durable key -- is what a public transparency log records. [Trust model](/docs/trust-model/#identity-sigstore-not-key-signing-parties) uses this for agent identity directly, since `zz` already has the OAuth login this needs.

**[SLSA](https://slsa.dev/)**'s min-reduction over a dependency graph (an artifact's guarantee is bounded by its weakest attested dependency) is the direct model for computing effective attestation level over `zz`'s own existing dependency rungs, and recent work extending Sigstore-style attestation specifically to AI agent generation (binding a signed plan to a model's output, agent and model identity as attestable material) is close, real prior art for parts of this -- though it attests each agent invocation as a discrete unit and doesn't propagate trust through a creation chain, which is the one piece of [Trust model](/docs/trust-model/#open-the-vouch-graph)'s own design that isn't borrowed from anywhere.

## Held for later

**Phabricator's Herald** (declarative "when X, do Y" automation rules) is close to Tripwires. A fuller comparison, including policy-as-code tools like Open Policy Agent and pull-request automation like GitHub Actions and Danger, belongs with the Tripwire implementation work.
