# Lanes and Ladders

A **Lane** is a workstream: a named, addressable unit of work with a scope, a status, and a history. "Add OAuth provider support," "fix CVE-2026-XXXX," "the OCC merge pipeline refactor" are all Lanes. It's the one concrete object this whole design is built from — everything that used to be described as four separate pillars (coordination, auditability, searchability, navigation) is really just a property every Lane has.

## Anatomy of a Lane

- **Identity** — an ID, a name, a scope (what it touches, derived from the dependency graph as work happens, not declared upfront), and a status: proposed → open → claimed → active → merged/closed, or vetoed, or stopped.
- **Coordination surface** — ASK/ANSWER for requests and questions, HOLD/VETO for normal control, STOP/DROP/ROLL for incident response (full semantics in [docs/03-protocol.md](03-protocol.md)). Its OCC read/write-set is the union of what's been touched by work claimed under it. A "work queue item" and "a Lane" are the same object at different lifecycle stages — proposed Lane = backlog item, claimed Lane = active workstream.
- **Audit trail** — every ASK, ANSWER, HOLD, VETO, STOP, DROP, ROLL, merge, and Tripwire firing on the Lane is append-only, recorded in the repo's `.zz/` directory, tied to the commits it produces. The Lane's history and the code's history are the same artifact, never something you cross-reference between two places.
- **Ladder** — the Lane's own zoom levels: commits and sessions roll up into a Lane-level summary, which rolls up into the package- and repo-level summaries. The *global* summary ladder is literally built from Lane ladders rolling up, not computed as a separate pass.
- **Search unit** — independently indexed, structurally (what it touches, in D1) and semantically (what it's about, in Vectorize), so "which open lanes touch auth" or "find a lane like this one" are first-class queries.
- **Dual interface, one source of truth** — agents read and act on a Lane through ASK (structured RPC against the Maintainer). Humans get a rendered report, ad-hoc search, and raw clickthrough of the same underlying commits, summaries, and Tripwire firings. Different doors, same state — never two copies of the truth.

## Lifecycle

```
proposed → open → claimed → active → merged/closed
                      │
                      ├─ HOLD  (paused, reversible)
                      ├─ VETO  (rejected by the Maintainer/Owner policy)
                      └─ STOP  (halted by a Tripwire's runbook)
```

A Lane is proposed either by a human/Owner, by the Maintainer's own backlog grooming, by a Tripwire, or automatically as part of a cascade (below). It becomes open (claimable) once it has acceptance criteria. Claiming it starts a lease; abandoned leases expire and the Lane reopens.

## Durable Object nesting

Two axes, not one:

1. **Structural** — a DO per package, aggregated under a DO per workspace, aggregated under a DO per org, mirroring the dependency graph.
2. **Workstream** — a repo or package's Maintainer DO spawns and indexes N concurrent Lane DOs, one per active workstream. OCC conflict checks happen at the Lane level first (narrow, fast) and only consult sibling Lanes via the parent Maintainer's registry when scopes might overlap.

## Cascades are bundles of linked Lanes

A breaking-change cascade isn't a single Lane — it's a bundle of linked Lanes, one auto-opened in each affected consumer repo, all sharing a common origin pointer back to the change that caused them. This gives cascades full auditability for free: navigate from the origin to every spawned migration Lane and back, because they're just Lanes with a shared cascade ID.

## Roadmap is just the backlog

A roadmap isn't a separate artifact to maintain by hand — it's the set of proposed (not-yet-opened) Lanes, ordered and viewed at whatever zoom level you're at. A package's roadmap is its own proposed Lanes; an org's roadmap is the rollup across its packages' proposed Lanes.

## Ladders: deliberately left underspecified

A Ladder is the zoom structure described above — commit, Lane, package, repo, each level a compressed roll-up of the one below, and every summary must be able to point back to the exact commits it summarizes (never lose recall for precision).

What this document does **not** specify: the operations for moving between levels, generating a new level, or linking a summary back to its sources. Early drafts of this design tried to pre-assign verbs here (climb/descend/distill/chute, matching the fire-safety "chutes and ladders" wordplay), and that was the wrong move — it was nomenclature in search of commands, not commands derived from how Lanes actually get read and written once they exist. The right operations should come from real usage once Maintainers and Lanes are running, not be designed in the abstract. Revisit this section once there's a working Ladder to observe.

## The pillars, as a vocabulary

Coordination, auditability, searchability, and navigation aren't separate systems — they're four lenses for describing what a Lane and its Ladder already do:

- **Coordination** — the ASK/ANSWER/HOLD/VETO surface, OCC merge, the open work queue, cascading obligations, negotiated generalization over fork-first.
- **Auditability** — the `.zz/` append-only trail, git as the real source of record, two-speed review (deterministic checks before any model judgment).
- **Searchability** — structural queries (D1) and semantic queries (Vectorize) against every Lane, including Lanes forked in from repos that aren't natively part of the system yet.
- **Navigation** — the Ladder, and the dual agent/human interface onto it.

Mechanics for each are documented inline above and in [docs/03-protocol.md](03-protocol.md); none of them needs its own subsystem.
