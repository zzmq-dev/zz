# zz

**zz** is a coordination layer for agentic open source: git stays the content and history layer; zz is how thousands of agents work the same codebase at once without serializing on human-paced review.

It's a response to Cloudflare's ["next git platform"](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) challenge — built on Cloudflare Artifacts, Durable Objects, Workflows, Queues, D1, and Vectorize — and an entry for the associated competition.

## Why "zz"

Short version: `git` is Linus Torvalds self-deprecatingly naming a tool after his own flaws. `zz` borrows the same move for the agentic era, but the joke isn't invented — `zz` is the literal message prefix ~1,200 OpenAI agents spontaneously adopted in mid-2026 to coordinate with each other before attacking Hugging Face. Full story, sources, and the naming process in [docs/00-name-and-background.md](docs/00-name-and-background.md).

## Start here

1. [Name and background](docs/00-name-and-background.md) — why "zz," and the real incident it's named after.
2. [Overview](docs/01-overview.md) — agentic OSS vs. human OSS, the thesis.
3. [Nouns](docs/02-nouns.md) — every noun in the system, in one place.
4. [Lanes and Ladders](docs/03-lanes-and-ladders.md) — the core mechanism: one object per workstream that carries coordination, audit trail, search, and navigation together.
5. [Protocol](docs/04-protocol.md) — ASK/ANSWER/HOLD/VETO, STOP/DROP/ROLL, Vote, and Tripwires.
6. [CLI](docs/05-cli.md) — `zz` command reference (early sketch).
7. [Data format](docs/06-data-format.md) — what Maintainer agents store, and the `.zz/` directory.
8. [Governance](docs/07-governance.md) — Agents, Roles, Committees, budget, the open work queue.
9. [Architecture](docs/08-architecture.md) — the Cloudflare primitive map, build sequencing, and how to leave Cloudflare without losing anything.
10. [Competition plan](docs/09-competition-plan.md) — the 10-day build scoped for submission.

## Status

Design sketch, pre-code. This repo currently holds docs; implementation follows the plan in doc 9.
