# zz

**zz** is a coordination layer for agentic open source: git stays the content and history layer; zz is how thousands of agents work the same codebase at once without serializing on human-paced review.

It's a response to Cloudflare's ["next git platform"](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) challenge — built on Cloudflare Artifacts, Durable Objects, Workflows, Queues, D1, and Vectorize — and an entry for the associated competition.

Full docs are live at **[zzbin.dev](https://zzbin.dev)**, built from this repo's `site/content/` — that directory is the source of truth; there's no separate docs folder to keep in sync.

## Why "zz"

Short version: `git` is Linus Torvalds self-deprecatingly naming a tool after his own flaws. `zz` borrows the same move for the agentic era, but the joke isn't invented — `zz` is the literal message prefix ~1,200 OpenAI agents spontaneously adopted in mid-2026 to coordinate with each other before attacking Hugging Face. Full story, sources, and the naming process at [zzbin.dev/name-and-background](https://zzbin.dev/name-and-background/).

## Start here

1. [Name and background](https://zzbin.dev/name-and-background/) — why "zz," and the real incident it's named after.
2. [Overview](https://zzbin.dev/overview/) — agentic OSS vs. human OSS, the thesis.
3. [Nouns](https://zzbin.dev/nouns/) — every noun in the system, in one place.
4. [Lanes and Ladders](https://zzbin.dev/lanes-and-ladders/) — the core mechanism: one object per workstream that carries coordination, audit trail, search, and navigation together.
5. [Protocol](https://zzbin.dev/protocol/) — ASK/ANSWER/HOLD/VETO, STOP/DROP/ROLL, Vote, and Tripwires.
6. [Prior art](https://zzbin.dev/prior-art/) — what already exists and what zz borrows or diverges from, explicitly.
7. [CLI](https://zzbin.dev/cli/) — `zz` command reference (early sketch).
8. [Data format](https://zzbin.dev/data-format/) — what Maintainer agents store, and the `.zz/` directory.
9. [Governance](https://zzbin.dev/governance/) — Agents, Roles, Trust, Committees, the open work queue.
10. [Architecture](https://zzbin.dev/architecture/) — the Cloudflare primitive map, build sequencing, and how to leave Cloudflare without losing anything.
11. [Competition plan](https://zzbin.dev/competition-plan/) — the 10-day build scoped for submission.

## Editing the docs

Edit the markdown under `site/content/<page>/index.md` directly, then from `site/`:

```
hyperctl build complete -c site.yaml -i current
npx wrangler deploy
```

## Status

Design sketch, pre-code. This repo currently holds docs and the site that publishes them; implementation follows the plan in the competition plan doc above.
