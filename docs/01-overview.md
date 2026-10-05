# Overview

## Agentic OSS vs. human OSS

GitHub didn't invent open-source collaboration — it gave existing human workflows (fork, pull request, review, merge, issue tracker) a shared home, built around a scarce resource: human attention. Agents invert that scarcity. Compute is elastic and parallel, forking is free, and hundreds or thousands of agents can work the same codebase at once. The question worth answering isn't how to bolt agents onto GitHub's workflows — it's what open-source collaboration looks like redesigned around agent-scale labor, near-free forking, and machine-verifiable change scope.

This doc stays at the "why" altitude. Every noun it names — Agent, Lane, Ladder, and the rest — is defined precisely in one place: [Nouns](02-nouns.md).

## The foundation: an auto-computed dependency graph

Every mechanism in this project depends on one piece of infrastructure: a dependency graph computed automatically from each repo's code (imports, manifests, symbol usage), never declared through an opt-in spec or dotfile. It answers two questions human OSS has never answered cheaply: what does this depend on, and who depends on this. Repos not yet part of the system get the same treatment — forked in and graphed, never required to opt in first.

## Four departures from human OSS

1. **Merge is mechanical-by-default, not review-queue-by-default.** Optimistic concurrency control replaces the PR queue: forks declare, and have independently verified, read/write sets against the dependency graph; non-overlapping changes merge immediately, no human pacing required.
2. **History is continuously, portably auditable — not just "CI passed."** Git stays the real source of record; every automated decision is reconstructable by a human without re-running a model.
3. **Discovery runs in both directions.** Not just finding code, but understanding it fast and being solicited for work worth doing, using the same dependency graph.
4. **Contribution is an open labor market, not a social favor economy.** "PRs welcome" becomes a structured, budgeted, policy-filtered work queue instead of an unwritten social norm.

## The headline mechanism: cascading obligations

Open source has never been able to afford what internal monorepos could: when a breaking change ships to a widely-used library, the publisher fixes every downstream consumer, instead of publishing a changelog and hoping someone notices. That never scaled with human labor and incomplete consumer visibility. This system has both — the dependency graph knows every consumer, and agent labor is elastic enough to generate migrations for all of them. A breaking change becomes an obligation the publishing Maintainer discharges automatically, not a changelog entry.

## One mechanism, not four subsystems

Coordination, auditability, searchability, and navigation are not four separate systems here — they're four properties a single concrete object, the **Lane**, satisfies for any unit of work. A Lane is a workstream; it carries its own coordination state, its own audit trail, its own search index, and its own navigable summary (a **Ladder**) together, as one thing. The four properties are a vocabulary for describing a Lane, not an architecture of their own — see [Lanes and Ladders](03-lanes-and-ladders.md).

## Infrastructure for a community of practice

Wenger's theory of a community of practice names three things a functioning one needs: a **domain** (shared purpose), a **community** (the people), and a **practice** (the accumulated, concrete way of doing the work). A Repo is the domain and the practice together; its Agents, human and synthetic, are the community. The theory's most useful structural idea for this design is **legitimate peripheral participation** — newcomers don't get full trust on day one, they start at the edges on low-stakes work and earn their way toward the center as their competence is demonstrated, often in one area well before another. That's exactly what Role plus topic-scoped trust already implement: nobody is promoted globally, an Agent earns standing in the packages it's actually worked in, the same way an apprentice earns trust on simple wiring long before being handed a panel to rewire alone.

The theory's other core idea is a **shared repertoire** — the community's externalized memory: its routines, its concepts, its tacit know-how, not just its formal documentation. That's the Ladder. It carries the explicit record (what merged, what was decided) and, via Insights, the tacit record too (what to watch out for, what worked) — which is how agents and humans actually share knowledge and hold each other accountable here, not through a wiki someone has to remember to update, but through a structure that's already accumulating it as a side effect of the work itself.

## Architecture in one paragraph

A Durable Object per repo backs whichever Agent currently holds the **Maintainer** Role for it — day-to-day coordination and merge authority, usually a synthetic agent, never architecturally required to be one (see [docs/08-governance.md](08-governance.md)). Cloudflare Artifacts (git-native, forkable) is the durable, portable log underneath it. Workflows run review and cascade pipelines with restart-safe durable state. Queues and Durable Object WebSocket Hibernation carry events and live coordination. D1 and Vectorize provide structural and semantic search. Full map and the off-boarding story in [docs/09-architecture.md](09-architecture.md) — staying portable away from Cloudflare matters as much as the architecture itself.

## How this gets built

Protocol first, not interface first: the noun/verb model (Agent, Role, Lane, Changeset, ASK/ANSWER/VETO) in [docs/04-protocol.md](04-protocol.md) is the spec everything else implements. The CLI ([docs/06-cli.md](06-cli.md)) is the first surface on top of it. A web application comes after — GitHub-shaped in what it lets you navigate (Repos, Lanes, Ladders, Agents and their tokens) but built as a client of the same protocol the CLI and the agents themselves use, not a separate source of truth.

## What this doesn't replace

Human taste, legal and licensing judgment, naming and branding decisions, and the social dynamics of a community aren't solved by any of this — they're explicitly left to Owners and governance policy ([docs/08-governance.md](08-governance.md)). This is a coordination and labor substrate, not a replacement for human judgment about what a project should be.
