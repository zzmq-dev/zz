# Prior art

What already exists, and what zz borrows or diverges from, stated explicitly rather than left implicit.

## Multi-agent task allocation

The **Contract Net Protocol** (Reid G. Smith, 1980) is close to a direct precedent for ASK/ANSWER: a manager agent broadcasts a task announcement, other agents bid, the manager awards a contract to one. ASK-as-work-offer and ANSWER-as-claim are a production implementation of a fifty-year-old, well-studied pattern, not a new one.

**Blackboard systems** (Hearsay-II and the broader blackboard architecture) are the direct ancestor of a Lane as a shared surface multiple specialist agents post to and read from, each contributing when it can help. The same pattern also explains why the agents in [the incident this project is named after](00-name-and-background.md) converged on a message board unprompted — it's a well-known architecture, independently rediscovered.

Sources: [Smith, "The Contract Net Protocol," 1980](https://www.reidgsmith.com/The_Contract_Net_Protocol_Dec-1980.pdf) · [Contract Net Protocol overview](https://en.wikipedia.org/wiki/Contract_Net_Protocol)

## Production code review

**Gerrit** already has a close analog to Changeset: a "Change" is the reviewable unit, reviewers score it on labeled categories, and it becomes submittable once it clears its labels with no **veto vote** in any category — Gerrit's own term. That's independent, production validation of Changeset and VETO as the right shape, not a coincidence of naming.

Source: [Gerrit submit requirements](https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html)

## Merge queues

Bors and GitHub's Merge Queue solve concurrent landings by **serializing**: test each change against the current base one at a time, merge if green, move to the next. OCC diverges from this deliberately — non-overlapping changes merge in parallel rather than queueing behind each other, which is the throughput OCC exists to provide at agent scale.

That divergence has a real limit: OCC proves the absence of *mechanical* conflicts (overlapping symbols or lines), not *semantic* ones — two Changesets that touch disjoint code but are behaviorally incompatible together clear OCC's fast path and silently break something. A queue-shaped mechanism still exists for this, demoted from the primary gate to a periodic backstop: a recurring Lane that re-validates a batch of recently merged Changesets together, triggered on a cadence or by a Tripwire when merge density in some scope crosses a threshold, with ROLL as the recovery path on failure. High-contention files need no special handling either — a hotspot simply never clears OCC's fast path, so review concentrates exactly where it already belongs without serializing the rest of the repo.

## Is OCC itself novel?

Partially, and it's worth being precise about which part. Git's own merge is already optimistic — it proceeds without locking and checks for conflict only at merge time; that part isn't new. Git detects conflict at the **text-line level**, though, which produces both false positives (unrelated edits that happen to sit near each other in a file) and false negatives (edits on different lines that are semantically incompatible merge silently). Moving the unit of conflict detection to the **dependency graph's symbols** instead of text lines isn't new either — it's the same move build systems like Bazel and Pants already made for change-impact analysis, tracing the graph instead of diffing text. Structural, AST-aware merging is already a shipping product in Plastic SCM's **SemanticMerge**. And the term itself predates all of this: Kung and Robinson's 1981 paper on optimistic concurrency control describes read/write-set validation at transaction-commit time in databases — structurally identical to what happens here, applied to code instead of rows.

What's actually new is combining these three ideas — optimistic merging, graph-based impact analysis, structural conflict detection — into the mechanism that drives an agent coordination fast path specifically, wired into Lane, Claim, Trust, and Tripwire, rather than any one of the underlying techniques on its own.

Sources: [Kung & Robinson, "On Optimistic Methods for Concurrency Control," ACM TODS 1981](https://www.eecs.harvard.edu/~htk/publication/1981-tods-kung-robinson.pdf) · [SemanticMerge intro](https://www.semanticmerge.com/semanticmerge-intro-guide)

## Governance beyond a single Owner

Four real precedents inform Vote, lazy consensus, and the Committee model in [Governance](08-governance.md):

- **The Apache Software Foundation** — lazy consensus (propose, silence-is-assent) as the default, with a formal Vote only for decisions that need one. zz's ballots (`+1`/`+0`/`-0`/`-1`) are ASF's own.
- **Rust's RFC process and Final Comment Period** — the same lazy-consensus shape applied specifically to design decisions rather than code merges: propose, open a public countdown, proceed if nothing substantive blocks it.
- **IETF's "rough consensus and running code"** — an older, more famous instance of the same idea, predating both.
- **Debian's constitution** — supermajority requirements that scale with what's being decided (simple majority for routine resolutions, higher thresholds for overriding a maintainer or amending the constitution itself), the direct precedent for Vote's threshold varying by decision type.

One more, for sharded coordination specifically: **the Linux kernel's subsystem-maintainer tree**, where each subsystem maintainer merges independently into their own tree, flowing up through a hierarchy to Linus. It's evidence the sharded-Coordinator pattern scales to one of the largest codebases that exists.

## Held for later

**Phabricator's Herald** (declarative "when X, take action Y" automation rules) is close to Tripwires, but the fuller comparison — including policy-as-code tools like Open Policy Agent and GitHub Actions/Danger-style PR automation — belongs with the Tripwire implementation work, not here.
