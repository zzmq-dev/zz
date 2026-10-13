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

## Governance beyond a single Owner

Four precedents inform the planned Vote, lazy consensus, and Committee model in [Governance](/docs/governance/#committee):

- **The Apache Software Foundation** uses lazy consensus (propose, and silence means assent) by default, with a formal vote only for decisions that need one. `zz`'s ballots (`+1`, `+0`, `-0`, `-1`) are ASF's.
- **Rust's RFC process and Final Comment Period** apply lazy consensus to design decisions instead of code merges. A proposal opens a public countdown and proceeds if nothing substantive blocks it.
- **The IETF's "rough consensus and running code"** is an older and more famous instance of the idea.
- **Debian's constitution** sets supermajority requirements that scale with the decision, from a simple majority for routine resolutions to higher thresholds for overriding a maintainer or amending the constitution. It's the precedent for a Vote's threshold varying with what is being decided.

For splitting coordination across several coordinators, **the Linux kernel's subsystem-maintainer tree** is the model. Each subsystem maintainer merges independently into their own tree, and the trees flow up a hierarchy to Linus. It shows the pattern scales to one of the largest codebases there is.

## Held for later

**Phabricator's Herald** (declarative "when X, do Y" automation rules) is close to Tripwires. A fuller comparison, including policy-as-code tools like Open Policy Agent and pull-request automation like GitHub Actions and Danger, belongs with the Tripwire implementation work.
