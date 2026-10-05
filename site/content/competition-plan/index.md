---
layout: docs
title: "Competition plan"
description: "The 10-day build scoped for the Cloudflare competition submission."
---
# Competition plan

The brief explicitly asks for novel coordination, review, and merge mechanisms, not GitHub with agents bolted on — scope the entry around the one mechanism that proves that distinction.

## Scope: one vertical slice

Build a single-repo Maintainer, an auto-computed dependency graph (one language — JS/TS import analysis is the fastest path), an OCC merge pipeline with a `.zz/` decision log, and one cascade demo: a simulated breaking change auto-migrating two or three toy downstream consumer repos. That alone demonstrates coordination and auditability directly, gestures at governance, and is demonstrable in a short recorded walkthrough.

## Explicitly cut from the 10-day build

Full semantic search and Vectorize integration, the structural DO hierarchy, the trust/reputation system, and real external-repo shimming. Name these as roadmap in the writeup and the pitch — do not attempt to build them.

## The demo centerpiece: `zz top`

A live `zz top` screen recording — Lanes claiming, a HOLD firing, a cascade spawning three child Lanes across repos — is the single most legible thing to put in the submission video. It turns an abstract coordination mechanism into something a judge can watch happen in real time.

## Pitch framing for judges

Lead with the cascading-obligation mechanism: open source has never been able to afford Twitter-style, cross-consumer migration obligations when a library makes a breaking change. Agent labor makes it affordable, and Durable Objects, Artifacts, and Workflows are the only stack where the coordination actor, the durable log, and durable multi-step execution are all native primitives, not bolted-on infrastructure. The name and protocol (`zz`, ASK/ANSWER/HOLD/VETO/STOP) aren't an invented theme — they're the real vocabulary ~1,200 OpenAI agents converged on unprompted during the 2026 Hugging Face incident, formalized and hardened rather than replaced.

## Risks

- Dependency-graph computation accuracy for the demo language, under a 10-day timeline.
- Durable Object and Workflow integration maturity for patterns this specific — an OCC claim ledger, cascade orchestration.
- Making the mechanism legible in a short video: keep the toy example small and visual, three or four tiny repos rather than a real codebase, so the mechanism is obvious on screen.

## Ten-day schedule

| Days | Work |
| --- | --- |
| 1–2 | Artifacts binding, event wiring (push → Queue → Workflow) |
| 3–4 | Dependency graph, Maintainer DO skeleton |
| 5–6 | OCC merge, static check gate, `.zz/decisions/` logging |
| 7–8 | Cascade demo across toy repos |
| 9 | `zz top`, demo polish |
| 10 | Submission |
