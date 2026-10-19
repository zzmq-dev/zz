---
layout: docs
title: "Demos"
description: "Runnable scenarios for the zz demo video: voice-over script, exact commands, and the fixtures and live model runs behind each one."
---
# Demos

Each page here is one scenario from the [demo video](/docs/overview/) run sheet: a voice-over script to read aloud, the exact commands or code behind it, and what to expect when it runs. They're written to be followed, not just read — every command shown has actually been run against a real repo on `zzmq.dev`.

The first seven are the original `mathkit` run sheet, one function at a time, handing more of the work from the human to agents at each stage. The next two cover [Committee, Vote, VETO, Policy](/docs/governance/#committee) and [Whistleblow, STOP/DROP/ROLL](/docs/protocol/#incident-response) — governance and incident response, previously documented as **Planned**, now built at demo-level rigor and verified live. The last covers [Mediated conflict resolution](/docs/mediated-conflict-resolution/) — a real shared-dependency conflict, reconciled by a real model call instead of a forced pick.

## A rule for every scenario with a bad actor

Two of these scenarios need someone to do something wrong — commit a secret, propose a bad change. Reliably getting a real LLM to misbehave on cue isn't something to depend on for a recorded demo, so **the bad actor's action is always a scripted fixture**: a plain function call with fixed content, not a model making a choice. It's clearly marked as such on screen and in these pages.

Everything on the other side — voting, reviewing, deciding whether a report is credible, resolving it — is **a real, running model**, reading the actual proposal or evidence off the live protocol state and calling the real tools itself. Nothing about the good actors' half is pre-decided. Where a scenario shows both versions (a fast scripted one for rehearsal, and a live-model one for the real take), both are linked below.

## Stages

| Scenario | Proves | Assets |
| --- | --- | --- |
| [1. By hand](/docs/demos/by-hand/) | The whole protocol — Repo, Ask, Lane, Changeset, review, merge, Ladder — with no agent involved | CLI commands only |
| [2. Assisted](/docs/demos/assisted/) | A human stays in charge while an LLM drafts the work | `zz work --assist` |
| [3. Local agent](/docs/demos/local-agent/) | An agent speaks the same protocol a human does, slow enough to watch every step | `zz work --as`, Ollama |
| [4. Hosted agent](/docs/demos/hosted-agent/) | Model choice is a speed dial, nothing else changes | `zz work --as`, Groq |
| [5. Two roles](/docs/demos/two-roles/) | Separation of duties: a contributor that can't merge, a coordinator that can | two `zz work` processes |
| [6. Bulk Asks](/docs/demos/bulk-asks/) | Work spreads across several workers with no central dispatcher | `demo/bulk-ask.sh` |
| [7. Decomposition](/docs/demos/decomposition/) | One Ask splits into many, merging back up to the root | `--decompose` |
| [Committee Vote & Policy](/docs/demos/committee-vote-and-policy/) | A Policy change requires a real Vote, never just nobody objecting in time | `demo/governance-and-incident-demo.ts`, `demo/governance-live-agents.ts` |
| [Whistleblow & incident response](/docs/demos/whistleblow-and-incident-response/) | Tainted work gets caught, reverted for real, and recorded | same two scripts |
| [Mediated Conflict Resolution](/docs/demos/mediated-conflict-resolution/) | A real shared-dependency conflict gets reconciled by a real mediation call, not a forced pick -- and the fix surfaces for the next contributor automatically | `demo/mediated-conflict-demo.ts` |

## Setup shared by every scenario

```
zz login
zz top                 # confirm your repos show up
```

Agents created for one scenario (`zz agent create <name>`) stick around until you delete them (`zz agent delete <username>`) — names below carry a run-specific suffix where a script creates them, to avoid colliding with a previous take.

## Cleaning up

Stages 1–7 are one continuous take on the same `mathkit` repo and the same growing set of agents, each stage deliberately building on the one before it — there's nothing to clean up until [Stage 7](/docs/demos/decomposition/)'s own checkpoint, which covers the whole thing in one pass. The Committee Vote & Policy and Whistleblow demos are independent of `mathkit` and of each other's *repo* (each creates its own throwaway one) but share one script run and its four agents between them — clean up once, after whichever of the two you ran last. Mediated Conflict Resolution is fully independent of every other demo here — its own throwaway repo, no agents created at all (the script runs as whoever is logged in) — clean up with the one `zz repo delete` its own checkpoint prints. Every page's own checkpoint says exactly what that page added and, where it's the end of a chain, how to remove all of it.
