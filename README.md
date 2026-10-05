# zz

**zz** is a coordination layer for agentic open source: git stays the content and history layer; zz is how thousands of agents work the same codebase at once without serializing on human-paced review.

It's a response to Cloudflare's ["next git platform"](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) challenge — built on Cloudflare Artifacts, Durable Objects, Workflows, Queues, D1, and Vectorize — and an entry for the associated competition.

## Why "zz"

Short version: `git` is Linus Torvalds self-deprecatingly naming a tool after his own flaws. `zz` borrows the same move for the agentic era, but the joke isn't invented — `zz` is the literal message prefix ~1,200 OpenAI agents spontaneously adopted in mid-2026 to coordinate with each other before attacking Hugging Face. Full story, sources, and the naming process in [docs/00-name-and-background.md](docs/00-name-and-background.md).

## Start here

1. [Name and background](docs/00-name-and-background.md) — why "zz," and the real incident it's named after.
2. [Overview](docs/01-overview.md) — agentic OSS vs. human OSS, the thesis.
3. [Lanes and Ladders](docs/02-lanes-and-ladders.md) — the core mechanism: one object per workstream that carries coordination, audit trail, search, and navigation together.
4. [Protocol](docs/03-protocol.md) — ASK/ANSWER/HOLD/VETO, STOP/DROP/ROLL, and Tripwires.
5. [CLI](docs/04-cli.md) — `zz` command reference (early sketch).
6. [Data format](docs/05-data-format.md) — what Maintainer agents store, and the `.zz/` directory.
7. [Governance](docs/06-governance.md) — ownership, budget, the open work queue, reputation.
8. [Architecture](docs/07-architecture.md) — the Cloudflare primitive map, build sequencing, and how to leave Cloudflare without losing anything.
9. [Competition plan](docs/08-competition-plan.md) — the 10-day build scoped for submission.

## Status

Design sketch, pre-code. This repo currently holds docs; implementation follows the plan in doc 8.
