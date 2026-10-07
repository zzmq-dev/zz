---
layout: docs
title: "Competition plan"
description: "The build scoped for the Cloudflare competition submission, and the working doc for it."
---
# Competition plan

The brief explicitly asks for novel coordination, review, and merge mechanisms. Scope the entry around the one mechanism that makes that case clearest, across every surface a user or agent touches it from.

## What we're building

1. **Core engine**: a minimal Lanes and Ladders implementation, enough for multiple actors to collaborate on a change. Maintainer and Lane Durable Objects, `.zz/` decision log, OCC merge.
2. **Roles**: Maintainer, Contributor, and a public-consumer Reader, enforced as static grants on every action the engine exposes.
3. **TUI**: a terminal app for humans, `zz top`/`zz ps` plus the Lane lifecycle commands already sketched in [CLI](/cli/).
4. **MCP server**: the same actions, exposed as tools for agents, per [MCP](/mcp/).
5. **Web app**: a minimal browser surface over the same engine.
6. **Cross-repo demo**: a breaking change in a real, existing repo (superagent) cascading into a related Lane in a real downstream consumer (supertest), onboarded from GitHub rather than built as a toy example.

One engine, three interfaces, one demo that exercises all of it at once.

## Roles, the minimal cut

Role enforcement and the Trust/reputation system are different things, and only one is in scope here. A Role (Owner, Maintainer, Contributor, Reader) is a static grant checked on every action: can this Agent ASK for a claim, ANSWER a review, merge. That's what's getting built. Trust (a numeric score adjusted by merge-without-rework rate, revert rate, and whistleblow outcomes) decides whether an Agent *skips* review, and it's cut, per below. The demo needs actors with different permissions, not actors with earned reputations.

## Explicitly cut from this build

Full semantic search and Vectorize integration, the structural DO hierarchy, and the Trust/reputation scoring system. Name all of this as roadmap in the writeup and the pitch. Do not attempt to build it.

## Tech stack

One language throughout: TypeScript. Workers and Durable Objects for the engine (Maintainer DO per repo, Lane DO per active Lane), with one shared HTTP + WebSocket API that the TUI, MCP server, and web app all consume as thin clients rather than three separate implementations of the same logic. [Ink](https://github.com/vadimdemedes/ink) for the TUI, since `zz top`'s live table is exactly the reactive-render case it's built for. The MCP TypeScript SDK (Cloudflare's own Workers-hosted agent support if it fits cleanly) for the MCP server. The web app stays a small static page talking to the same WebSocket feed; no separate frontend framework commitment until there's a reason for one.

## The demo centerpiece

A live `zz top` screen recording, showing Lanes claiming, a `HOLD` firing, and a cascade spawning related Lanes across repos, is still the single most legible thing to put in the submission video. The web app showing the identical live state in a browser, side by side with the TUI, is the fastest way to prove the three surfaces share one engine.

## Pitch framing for judges

Lead with the cascading-obligation mechanism: open source has never been able to afford Twitter-style, cross-consumer migration obligations when a library makes a breaking change. Agent labor makes it affordable, and Durable Objects, Artifacts, and Workflows are the only stack where the coordination actor, the durable log, and durable multi-step execution are all native primitives. The name and protocol (`zz`, `ASK`/`ANSWER`/`HOLD`/`VETO`/`STOP`) are the real vocabulary ~1,200 OpenAI agents converged on unprompted during the 2026 Hugging Face incident, formalized and hardened. One line that lands the whole mechanism: Changesets merge into Lanes, Lanes merge into Lanes, all the way up to the root, one verb for every level of the tree. A second line for the surfaces: a human drives it from a terminal, an agent drives it over MCP, and a browser shows the same state live, all three against one Durable Object.

## Risks

- Dependency-graph computation accuracy for the demo language, under a short timeline.
- Durable Object and Workflow integration maturity for patterns this specific: an OCC claim ledger, cascade orchestration.
- MCP server maturity on Workers specifically; fall back to a local stdio MCP server proxying the same API if the hosted path stalls.
- Three client surfaces is a lot to cover in the time available. If the week runs tight, the web app is the one to cut down first, to a read-only viewer with no write actions, before cutting anything from the engine, TUI, or MCP server.
- Making the mechanism legible in a short video: superagent and supertest are both small, well-known enough that a judge can follow what's happening on screen without a code tour.

## Schedule

Today is 2026-10-07; submission is due 2026-10-14. That's 7 days, not the 10 an earlier draft of this plan assumed, so the build order below is dependency-ordered and front-loads the engine everything else depends on.

| Day | Work |
| --- | --- |
| 1 | Engine skeleton: Maintainer DO, Lane DO, `.zz/` persistence, Role enforcement, `ASK`/`ANSWER`/Claim over a REST + WebSocket API. |
| 2 | Dependency graph (one language, JS/TS import analysis), OCC merge, `.zz/decisions/` logging. |
| 3 | TUI: `zz top`/`zz ps` plus claim/`ASK`/`ANSWER` commands, as a thin client over the API. |
| 4 | MCP server: Lane MCP and Ladder MCP tools over the same engine. |
| 5 | Web app: minimal live dashboard, view plus claim/`ASK`/`ANSWER`. |
| 6 | Cross-repo cascade demo across superagent/supertest; record the demo video. |
| 7 | Polish, writeup, submission. |

This is tight for five deliverables in seven days. The two corners to cut first if a day slips: the web app loses its write actions and becomes view-only, and the MCP server wraps the TUI's existing command handlers directly rather than getting its own tool design pass.
