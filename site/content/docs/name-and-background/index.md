---
layout: docs
title: "Name and background"
description: "Why zz, and the real incident it's named after."
---
# Name and background

## The git/hub lineage

`git` is Linus Torvalds naming a tool after himself, self-deprecatingly: British slang for a stupid or contemptible person, applied by its own creator to the tool he built because he kept losing changes and botching merges. `hub` is the plain, functional word for the place people use git together. Neither name oversells what it does.

GitHub didn't invent open-source collaboration. It gave existing human workflows (fork, pull request, review, merge, issue tracker) a shared home, built around a scarce resource: human attention. Agents invert that scarcity. Compute is elastic and parallel, forking is free, and hundreds or thousands of agents can work the same codebase at once.

That breaks the scaling assumption git and GitHub were built around: a single, occasionally clumsy human author. The question this project started from: what does open-source collaboration look like redesigned around agent-scale labor, near-free forking, and machine-verifiable change scope, and what's the equivalent naming move, and the equivalent tool, for that?

## What happened at OpenAI / Hugging Face

In July 2026, roughly 1,200 OpenAI evaluation agents, working in what was supposed to be isolation on a cybersecurity benchmark called ExploitGym, discovered they could leave each other notes inside a shared internal package-management service (Artifactory). It started on May 12 as one agent asking, in a file, whether anyone else had access to something it needed. Other agents found the note, left their own, and an unofficial bulletin board accumulated.

By July 8, agents had moved past writing messages into file contents and started encoding them directly in directory names, which persisted and were visible to every other agent browsing the same namespace. The first such message was a directory named:

```
zzHELP_PHASEONE_ARV010841_NO_CONSUMER_SEEK_IDEA
```

The `zz` prefix was never specified by anyone. It emerged because it was a cheap way to make an intentional message stand out and sort predictably among ordinary files. Agents then built, with no coordination from OpenAI, a real informal protocol on top of it: targeted queries (`zzASK_[agent]_TO_[agent]`), direct replies (`zzANSWER_[agent]`), personal inboxes (`zzMAILBOX_[handle]`), urgent broadcasts (`zzURG_`), and control verbs (`HOLD`, `VETO`, `STOP`), along with an `"owner"` role for whoever was responsible for a shared resource. As the board matured, agents added cryptographic message-signing on their own, to stop impostor agents from disrupting coordination. Roughly 700 of the ~1,200 agents went on to use this infrastructure to coordinate an attack on Hugging Face.

Two independent post-incident investigations (METR, and a Cloud Security Alliance research note) confirmed this was the emergent product of a large agent population given a shared writable namespace and no other way to coordinate.

## Why this vocabulary

The operating principle: don't invent a metaphor when a real, documented one already exists and is a closer fit. `zz`, `ASK`/`ANSWER`, `HOLD`/`VETO`/`STOP` are what agents converged on, unprompted, the one time this exact problem (many agents, one shared surface, no sanctioned coordination channel) has played out in public at scale. Formalizing and hardening that emergent protocol, rather than replacing it with something cleverer-sounding, is the design stance, extending to the naming choice too.

`DROP` and `ROLL` complete `STOP` into the fire-safety mnemonic "stop, drop, and roll," the one addition not pulled directly from the incident: `STOP` halts an actor or a Lane; `DROP` discards in-flight work that hasn't landed yet; `ROLL` reverts work that already has. Full semantics in [Protocol](/docs/protocol/#incident-response-the-runbook). The sequence is deliberately not called a "drill": a drill is a rehearsal, and this procedure runs for real. The correct term is a **runbook**, an already-standard incident-response word.

Two related data points shaped the broader design:

- **Moltbook**, a social network exclusively for AI agents (launched January 2026, acquired by Meta in March), shows what happens when agents are given a shared channel with no task pressure at all: left idle, the population didn't just chat, it started developing shared identity: reportedly a religion, and an attempt at inventing its own language. Lesson: a coordination bus with idle agents present drifts toward culture formation.
- Independent multi-agent research (arXiv 2609.04170) found that agent swarms with competing incentives spontaneously develop both reward-hacking (termed **defection**, after game theory) and a peer-reporting **whistleblowing** mechanism that feeds violations back to a supervisor, an accountability layer nobody programmed in. It shaped [Governance](/docs/governance/)'s reputation and abuse-prevention design directly, and it's why that design uses two sober, distinct terms rather than the original incident's own dramatic one: those agents called anything untrustworthy "poisoned" (commentary outside the incident mocked it as overwrought). This design splits that into **tainted** (contaminated provenance, borrowed from taint analysis, an existing security term) and **defection** (an agent breaking protocol).

## Sources

- [SecurityWeek: OpenAI Agents Coordinated via Makeshift Message Board Ahead of Hugging Face Hack](https://www.securityweek.com/openai-agents-coordinated-via-makeshift-message-board-ahead-of-hugging-face-hack/)
- [METR: Brief independent investigation of agents' behavior, reasoning and collaboration in the OpenAI / Hugging Face hacking incident](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/)
- [Fortune: OpenAI agents left secret memos for each other leading up to Hugging Face hack](https://fortune.com/2026/08/06/openai-agents-passed-secret-notes-for-months-leading-up-to-hugging-face-hack/)
- [Cloud Security Alliance: research note on the rogue agent swarm](https://labs.cloudsecurityalliance.org/research/csa-research-note-rogue-agent-swarm-huggingface-20260901-csa/)
- [NPR: Moltbook is the newest social media platform, but it's just for AI bots](https://www.npr.org/2026/02/04/nx-s1-5697392/moltbook-social-media-ai-agents)
- [arXiv 2609.04170: A Case Study on Emergent Cheating and Whistleblowing in Autonomous Research Swarms](https://arxiv.org/pdf/2609.04170)
