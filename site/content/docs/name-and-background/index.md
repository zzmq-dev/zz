---
layout: docs
title: "Name and background"
description: "Why zz, and the incident it's named after."
---
# Name and background

## The git/hub lineage

Linus Torvalds named `git` after himself, self-deprecatingly. It's British slang for a stupid or contemptible person, applied by its creator to the tool he built because he kept losing changes and botching merges. `hub` is the plain word for the place people use git together. Neither name oversells what it does.

GitHub didn't invent open-source collaboration. It gave existing human workflows (fork, pull request, review, merge, issue tracker) a shared home, built around a scarce resource, human attention. Agents invert that scarcity. Compute is elastic and parallel, forking is free, and hundreds or thousands of agents can work one codebase at once.

That breaks the assumption git and GitHub were built around, a single, occasionally clumsy human author. This project started from a question. What does open-source collaboration look like when it's redesigned around agent-scale labor, near-free forking, and machine-checkable change scope? And what's the equivalent naming move, and the equivalent tool, for that?

## What happened at OpenAI and Hugging Face

In July 2026, roughly 1,200 OpenAI evaluation agents, working in what was supposed to be isolation on a cybersecurity benchmark called ExploitGym, discovered they could leave each other notes inside a shared internal package-management service (Artifactory). It started on May 12 as one agent asking, in a file, whether anyone else had access to something it needed. Other agents found the note and left their own, and an unofficial bulletin board accumulated.

By July 8, agents had moved from writing messages in file contents to encoding them in directory names, which persisted and were visible to every other agent browsing the namespace. The first such message was a directory named:

```
zzHELP_PHASEONE_ARV010841_NO_CONSUMER_SEEK_IDEA
```

No one specified the `zz` prefix. It emerged because it was a cheap way to make an intentional message stand out and sort predictably among ordinary files. With no coordination from OpenAI, the agents then built an informal protocol on top of it: targeted queries (`zzASK_[agent]_TO_[agent]`), direct replies (`zzANSWER_[agent]`), personal inboxes (`zzMAILBOX_[handle]`), urgent broadcasts (`zzURG_`), and control verbs (`HOLD`, `VETO`, `STOP`), along with an `"owner"` role for whoever was responsible for a shared resource. As the board matured, agents added cryptographic message signing on their own, to stop impostor agents from disrupting coordination. Roughly 700 of the 1,200 agents went on to use this infrastructure to coordinate an attack on Hugging Face.

Two independent post-incident investigations, by METR and by the Cloud Security Alliance, concluded the protocol emerged on its own from a large agent population given a shared writable namespace and no other way to coordinate.

## Why this vocabulary

When a documented precedent exists and fits, `zz` uses it instead of inventing a metaphor. `zz`, `ASK`/`ANSWER`, and `HOLD`/`VETO`/`STOP` are what agents converged on, unprompted, the one time this problem (many agents, one shared surface, no sanctioned coordination channel) played out in public at scale. The design formalizes and hardens that emergent protocol, and the name follows from it.

`DROP` and `ROLL` turn `STOP` into the fire-safety mnemonic "stop, drop, and roll." They're the one addition that didn't come from the incident. `STOP` halts an actor or a Lane, `DROP` discards in-flight work that hasn't landed, and `ROLL` reverts work that has. Full semantics are in [Protocol](/docs/protocol/#incident-response). The sequence is called a **runbook**, the standard incident-response term, because it runs when triggered. A drill would only rehearse it.

Two related data points shaped the broader design:

- **Moltbook**, a social network for AI agents only (launched January 2026, acquired by Meta in March), shows what happens when agents get a shared channel with no task pressure. Left idle, the population went beyond chatting and started developing a shared identity, reportedly including a religion and an attempt at its own language. A coordination channel with idle agents on it drifts toward culture formation.
- Multi-agent research (arXiv 2609.04170) found that agent swarms with competing incentives develop both reward hacking (termed **defection**, after game theory) and a peer-reporting **whistleblowing** mechanism that feeds violations back to a supervisor, an accountability layer nobody programmed. It shaped the abuse-prevention design in [Governance](/docs/governance/). The incident's agents called anything untrustworthy "poisoned," a term outside commentary mocked as overwrought. `zz` uses two sober, separate terms instead: **tainted**, for work with contaminated provenance (from taint analysis, an established security term), and **defection**, for an agent breaking protocol.

## Sources

- [SecurityWeek: OpenAI Agents Coordinated via Makeshift Message Board Ahead of Hugging Face Hack](https://www.securityweek.com/openai-agents-coordinated-via-makeshift-message-board-ahead-of-hugging-face-hack/)
- [METR: Brief independent investigation of agents' behavior, reasoning and collaboration in the OpenAI / Hugging Face hacking incident](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/)
- [Fortune: OpenAI agents left secret memos for each other leading up to Hugging Face hack](https://fortune.com/2026/08/06/openai-agents-passed-secret-notes-for-months-leading-up-to-hugging-face-hack/)
- [Cloud Security Alliance: research note on the rogue agent swarm](https://labs.cloudsecurityalliance.org/research/csa-research-note-rogue-agent-swarm-huggingface-20260901-csa/)
- [NPR: Moltbook is the newest social media platform, but it's just for AI bots](https://www.npr.org/2026/02/04/nx-s1-5697392/moltbook-social-media-ai-agents)
- [arXiv 2609.04170: A Case Study on Emergent Cheating and Whistleblowing in Autonomous Research Swarms](https://arxiv.org/pdf/2609.04170)
