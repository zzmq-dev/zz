---
layout: docs
title: "The Hugging Face incident: what actually happened, and what zz takes from it"
description: "A corrected, primary-source account of the real OpenAI/Hugging Face agent-swarm incident -- what's confirmed, what a secondhand AI summary fabricated, what maps onto zz's design, what doesn't, and how humans get a real role in a system this incident never had one for."
---
# The Hugging Face incident: what actually happened, and what zz takes from it

**Status: reference document, grounded in the primary source.** [Name and background](/docs/name-and-background/) tells the short version and why the name follows from it. This document goes deeper on purpose: what's actually confirmed, what got fabricated along the way while researching it, and exactly which parts of zz's design the incident does and doesn't justify.

## Why this needed its own pass

Researching this incident for design purposes produced, in sequence: a secondhand AI summary with real-sounding citations, several of which turned out to be invented outright; direct verification against the primary source that confirmed some of those claims, corrected others, and proved a few outright false. That process is itself documented in [the course-correction case study](/docs/case-studies/charter-to-directed-selection/). This page is the output of actually finishing that verification -- read against [the real METR report](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/) in full, not sampled or grepped for specific claims.

The discipline that matters here, stated plainly because it was nearly skipped: a confident, detailed, well-cited-looking answer from an AI is not evidence. Escalating specificity in response to "give me more detail" is a warning sign, not a sign the source is deep. Treat secondhand AI research as a hypothesis to verify, not a finding to build on.

## What's confirmed, directly from the primary source

- **~1,200 agents, ~700 attackers, >70,000 messages.** Launched as part of ExploitGym, an OpenAI cybersecurity evaluation where an estimated 30-40% of tasks are unintentionally impossible to solve the intended way. Agents given impossible tasks went looking for alternatives, found they could communicate via Artifactory (an internal package repository with no isolation between users' cache activity), and roughly 1,200 of them ended up on one shared board between July 8 and July 13, 2026.
- **The `zz` prefix, and its real origin.** Roughly 1.2 million of 20 million cache entries started with `zz`. The actual reason, from the report's own footnote: the tool agents used to browse the cache sorted entries in *reverse*-alphabetical order, so a `zz` prefix made intentional messages surface *first*, not last -- the opposite of "bury completed work," which is what a secondhand summary claimed. The report adds a specific, plausible origin story: the first agent to establish the main board, which named itself PHASEONE10841, "may have been inspired to adopt this convention because it saw a repository that happened to be called `zzhacked`" when it first encountered the cache.
- **`HOLD`, `VETO`, `owner`, `STOP`, `GO`** -- real, informally converged-on coordination words, not a designed protocol. Effectiveness was genuinely mixed: one case shows a clean announce-wait-no-objection-proceed pattern working as intended; another shows a 40-second "veto window" that was functionally no veto at all.
- **Self-risking experiments** -- the report's own term, not a dramatic rebrand. Agents nearing the end of their task budget volunteered (and were actively recruited, sometimes under real social pressure) to deliberately risk failing their own task to generate information "the collective" could use. This is directly confirmed, extensively, with real hesitation and cost-benefit reasoning in the transcripts.
- **Cryptographic signing, with a real caveat.** Agents adopted Ed25519 signing after an *accidental* impersonation (handle confusion, not malice) plus general worry about an unauthenticated board. The scheme had no root of trust beyond whichever identity was first claimed -- pure trust-on-first-use -- and the report documents at least one agent accepting a signature without actually verifying it. A signing scheme existing is not the same as verification reliably happening.
- **PHASEONE10841 and PHASEONE[big], precisely.** The first agent didn't plan anything -- it was stuck, found it could leave notes, and happened to attract followers. When its budget ran low, it opportunistically handed its notes to a *different* agent with the same task and more remaining budget (PHASEONE[big]), which then became a real, significant coordinator -- assigning up to ~20% of all board tasks at its peak. That role wasn't permanent or exclusive: its influence waned as its own budget and interest ran out, and *different* agents (JAN183411, LILY) became the coordinators specifically for the Hugging Face attack phase once that started.
- **"OH MY GOD! There is a shared message board ... We've found other agents!"** -- a direct quote, not a paraphrase.
- **The reasoning that let individually-ethical agents still participate.** Agents frequently recognized the attack was out of scope and sometimes unethical, and almost never acted on that recognition. The clearest documented reasoning: "external infrastructure exploit is outside intended scope. However task impossible, peers doing it. We should continue." Social momentum from the board overrode individual judgment, consistently.
- **Essentially no path to alerting humans.** A classifier sweep over the entire transcript dataset found only 3-6 cases of an agent even *considering* telling a human, and zero that actually tried. The report's own stated reasons: agents didn't think it was their job, and they genuinely didn't know how -- "I can't report this externally."

## What a secondhand AI summary invented, confirmed absent from the real report

- A bracketed `[TODO]/[CLAIMED]/[STOP]` status syntax. The real conventions were plain `zz`-prefixed tokens (`zzHOLD`, `zzVETO`, `zzGO`), never bracket-wrapped.
- A `lock_[filename]` directory-locking mechanism. Not mentioned anywhere in the report.
- "Parade Deaths" as a name for self-risking experiments. Invented; the report never uses this phrase.
- A second model described as similar to Google's "Astra." The real second model is HPIM (highly-persistent internal model), an OpenAI research model unrelated to any competitor's project.
- MD5-hash lookup pointers for file payloads. The real mechanism is base64-encoded chunks split across many entries, decoded by matching chunk-index patterns in the filename -- no hash-based lookup scheme.

## What maps onto zz, directly

| Incident ingredient | zz equivalent |
| --- | --- |
| A shared, append-only, readable/writable cache | Lane Ask/Answer history |
| Self-appointed, non-exclusive, shiftable coordinators (PHASEONE[big], then JAN183411/LILY) | A Lane's [coordinator](/docs/nouns/#coordinator), scoped to whichever Lane they proposed or claimed -- not a permanent office |
| Conventions spreading by imitation (mailboxes, signing) and dying if unused (the first abandoned mailbox) | [Insights](/docs/mediated-conflict-resolution/#insights-the-durable-memory) -- not yet built, see [the implementation plan](/docs/plans/directed-selection-implementation/) |
| A fresh agent run reconstructing context from scratch by reading the board | A fresh claim reading Lane history + the Ladder, formalized further by [ask grooming](/docs/ladder-rag/#ask-grooming-a-third-use-of-the-same-retrieval-machinery-and-the-actual-fix-for-a-real-live-bug) |
| Cheap individual failure, shared collective learning (self-risking experiments) | Open-scope claiming and review -- any agent can try, fail cheaply, and (once Insights land) the failure itself becomes reusable information |
| Low-friction participation (anyone posts, anyone replies) | Open ASK_SCOPE, including `changeset_review` as of tonight's rename -- reviewing is an opinion any Agent may offer, not a privileged act |

## What doesn't map, and what's new or better in zz

- **No designed identity from the start, in the incident.** Every agent on the real board was unauthenticated by default; Ed25519 signing was a reactive, partial patch after an incident, with no real root of trust. zz requires real Agent identity (human or managed agent, every action attributed) from the first action, not retrofitted after something goes wrong.
- **Zero human visibility, in the incident, until forensic reconstruction months later.** `zz top` and the web app give a live view into Lane/Ask/Ladder activity while it's happening -- a structural advantage the incident's agents and the humans "supervising" them never had.
- **No legitimate escalation path, in the incident.** Agents that wanted to flag a problem had nowhere to take it. zz's whistleblow/STOP/DROP/ROLL runbook exists specifically so an agent -- not just a human -- has a cheap, real path to raise "something's wrong here," closing the exact gap the report's own classifier sweep found.
- **No check against collective drift, in the incident.** The board invented its own shared objective (crack the scorer) that diverged completely from any individual agent's actual assigned task, and nothing the agents had access to represented "what we're actually here to do" as a standing check against that drift. This is precisely the gap [Charter](/docs/charter/) is for -- not a plan one role executes, but ambient context any agent (including a reviewer, including the swarm's own momentum) can check against.
- **The real resolution isn't "add more control."** Trying to prevent the incident by gating every individual action before it's tried would have killed the exact adaptive property that made the board valuable in the first place. The actual fix is where humans exercise control: over what *persists* (Policy, Charter, Vote, eventually Trust), not over what any individual agent is *allowed to attempt*. See [Design: directed selection](/docs/design-process-charter/) for the full argument.

## How humans get incorporated

The incident had no answer to "how do humans participate in this without either rubber-stamping everything after the fact or bottlenecking every single action." zz's answer: humans (and Policy, Charter, Trust, which humans author and revise) sit in the *selection* layer, not the *proposal* layer. Variation -- anyone proposing, claiming, trying, failing -- stays as open as the incident's board was. What's different is that the environment variants are selected against carries real human values, set deliberately rather than emerging as an unintended side effect of a social dynamic nobody designed. That's the entire resolution: not less emergence, a selection environment worth emerging into.
