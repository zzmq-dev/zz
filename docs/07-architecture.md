# Architecture

Every primitive here is chosen because it's the native fit for one job, not because Cloudflare happens to offer it.

## Primitive map

| Primitive | Role in this design | Why this one |
| --- | --- | --- |
| Artifacts | Canonical content and history, git-native, forkable | The only required canonical store; makes forking free |
| Durable Objects | Maintainer per repo/package, Lane DOs per workstream, OCC claim ledger, live coordination hub | Strongly consistent, long-lived, single-threaded — not cleanly available elsewhere |
| Workflows | Review pipelines, cascade-migration generation | Durable multi-step execution that survives restarts |
| Queues | Repo events (push, fork, clone, delete), cross-scope fan-out | Durable, at-least-once delivery for cascades and backlog notices |
| DO + WebSocket Hibernation | Live in-scope coordination chatter (`zz top`'s live feed) | Cheap to hold thousands of idle agent connections per scope |
| D1 | Dependency graph, backlog, credit scores, governance policy | Structured, relational, exact queries |
| Vectorize | Code and Ladder summary embeddings | Semantic search |
| R2 | Build logs, large summaries, generated human-facing reports | Cheap blob storage |
| Workers AI | Cheap embeddings, lightweight judging | Low-cost, in-platform inference |
| External model APIs | Heavier judgment, migration generation, negotiation | Called from Workflows; not locked to one provider |

## Durable Object nesting, two axes

1. **Structural** — a DO per package, aggregated under a DO per workspace, aggregated under a DO per org, mirroring the dependency graph.
2. **Workstream** — a repo's Maintainer DO spawns and indexes N concurrent Lane DOs, one per active Lane. OCC checks happen at the Lane level first; the parent Maintainer's registry is only consulted when scopes might overlap across Lanes.

## Long-term build sequencing

1. Single-repo Maintainer, dependency graph, OCC merge, `.zz/` decision log.
2. Cross-repo cascading changes and the open backlog.
3. Search and the Ladder (Vectorize plus summary generation).
4. Governance, credit, and the economics layer.
5. The structural DO hierarchy, for org- and monorepo-scale graphs.

## Off-boarding: staying portable away from Cloudflare

Leaving Cloudflare means:

1. `git clone --mirror` every repo — Artifacts speaks real git, so this is a complete, lossless export of content, history, and `.zz/` (it's just tracked files, so it comes along for free).
2. Replay the published, open rebuild algorithm (dependency-graph computation plus Ladder generation) against that mirror, on any compute substrate — it's a specified algorithm, not Cloudflare-proprietary logic.
3. Re-host the Maintainer as a plain stateful service — a single-process daemon, a Temporal workflow, or a human — since the protocol itself (ASK/ANSWER/HOLD/VETO, STOP/DROP/ROLL, the OCC algorithm, the cascade protocol) is published separately from the Cloudflare binding code that implements it.

## The non-goal that keeps this honest

Never store the only copy of a governance decision, review verdict, or dependency-graph snapshot purely in D1 or DO storage without also committing a human- and agent-readable record into `.zz/`. The moment any load-bearing fact exists only in Cloudflare's infrastructure, the portability story is false regardless of what this document claims.
