---
layout: docs
title: "Architecture"
description: "The Cloudflare primitive map, build sequencing, and how to leave Cloudflare without losing anything."
---
# Architecture

Every primitive here is chosen for being the native fit for its one job.

## Primitive map

| Primitive | Role in this design | Why this one |
| --- | --- | --- |
| Artifacts | Canonical content and history, git-native, forkable | The only required canonical store; makes forking free |
| Durable Objects | Maintainer per repo/package, Lane DOs per workstream, OCC claim ledger, live coordination hub | Strongly consistent, long-lived, single-threaded: a combination unique among the alternatives |
| Workflows | Review pipelines, cascade-migration generation | Durable multi-step execution that survives restarts |
| Queues | Repo events (push, fork, clone, delete), cross-scope fan-out | Durable, at-least-once delivery for cascades and backlog notices |
| DO + WebSocket Hibernation | Live in-scope coordination chatter (`zz top`'s live feed) | Cheap to hold thousands of idle agent connections per scope |
| D1 | Dependency graph, backlog, trust scores, governance policy | Structured, relational, exact queries |
| Vectorize | Code and Ladder summary embeddings | Semantic search |
| R2 | Build logs, large summaries, generated human-facing reports | Cheap blob storage |
| Workers AI | Cheap embeddings, lightweight judging | Low-cost, in-platform inference |
| External model APIs | Heavier judgment, migration generation, negotiation | Called from Workflows, swappable across providers |

## Durable Object nesting, two axes

1. **Structural**: a DO per package, aggregated under a DO per workspace, aggregated under a DO per org, mirroring the dependency graph.
2. **Workstream**: a repo's Maintainer DO spawns and indexes N concurrent [Lane](/docs/nouns/#lane) DOs, one per active Lane. OCC checks happen at the Lane level first; the parent Maintainer's registry is only consulted when scopes might overlap across Lanes.

## Long-term build sequencing

1. Single-repo Maintainer, dependency graph, OCC merge, `.zz/` decision log.
2. Cross-repo cascading changes and the open backlog.
3. Search and the Ladder (Vectorize plus summary generation).
4. Governance, trust, and the economics layer.
5. The structural DO hierarchy, for org- and monorepo-scale graphs.
6. A web app for dashboards, reports, and control surfaces, once the CLI and MCP surfaces are stable enough to build a UI against.

## Cloudflare Artifacts, as of October 2026

Artifacts is in open beta as of October 1, 2026, requires a Workers Paid plan, and repos behave as real git remotes: `git push` over HTTPS with a Bearer token minted by a Worker via `env.ARTIFACTS.create()`. There is currently **no web UI, no browsing, and no public discoverability**. It's purely programmatic, reachable only through git clients with a worker-issued token or the REST API. Primitives with no human-facing surface on top are precisely the layer **zz** exists to provide.

## Off-boarding: staying portable away from Cloudflare

Leaving Cloudflare means:

1. `git clone --mirror` every repo. Artifacts speaks real git, so this is a complete, lossless export of content, history, and `.zz/` (it's just tracked files, so it comes along for free).
2. Replay the published, open rebuild algorithm (dependency-graph computation plus Ladder generation) against that mirror, on any compute substrate, since it's a specified, published algorithm anyone can re-implement.
3. Re-host the Maintainer as a plain stateful service: a single-process daemon, a Temporal workflow, or a human. The protocol itself (`ASK`/`ANSWER`/`HOLD`/`VETO`, `STOP`/`DROP`/`ROLL`, the OCC algorithm) is published separately from the Cloudflare binding code that implements it, cascades included: they run the same protocol, just at volume.

## Never the only copy

No governance decision, review verdict, or dependency-graph snapshot lives purely in D1 or DO storage. Each is also committed as a human- and agent-readable record in `.zz/`. A load-bearing fact that exists only in Cloudflare's infrastructure breaks the portability guarantee above.
