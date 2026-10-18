---
layout: docs
title: "Planning and design"
description: "Not-yet-built designs, the standard they get checked against, and the research those designs actually draw on -- separated from the user-facing docs on purpose."
---
# Planning and design

Everything here is engineering-facing, not user-facing: designs for parts of zz that don't exist yet, the meta-level standard new designs get checked against before they're built, and the research and background those designs actually cite. If you're trying to use `zz` today, start at [Overview](/docs/overview/) instead -- everything in the main sidebar above this section describes what's real and working now.

Most pages here say so explicitly at the top (**Status: designed, not built**, or similar). That's not a disclaimer to skim past -- it's the actual point of keeping this section separate. A design doc describing a future state is a different kind of reading than a reference doc describing what a command does right now, and conflating them in one navigation made it hard to tell which was which.

| Page | What it covers |
| --- | --- |
| [Principles](/docs/principles/) | The five stated values design decisions get checked against, and why they're checkable rather than just felt. |
| [Design: directed selection](/docs/design-process-charter/) | The narrower, operationally-checkable standard specifically for architecture decisions -- variation stays open, selection carries real human-authored values. The checklist to run any new design idea against. |
| [How work gets done in zz](/docs/how-work-gets-done/) | The comprehensive mechanics-plus-philosophy explainer -- the deep version of [Overview](/docs/overview/), for understanding *why* zz is shaped the way it is, not just what each command does. |
| [Charter](/docs/charter/) | A repo's stated purpose and non-goals, checkable against a contribution the way Policy checks process -- consulted ambiently by any agent, not executed by one privileged role. |
| [Plan: building directed selection](/docs/plans/directed-selection-implementation/) | The sequenced build plan for Insights, Charter, drive-by contributions, and Trust-over-Role, each step naming the specific centralization drift it's guarding against. |
| [Lane, Ask, and Role boundaries](/docs/lanes-asks-and-roles/) | The Lane as the singular primitive, and the real Owner/Maintainer/Coordinator naming confusion this found and partially fixed. |
| [Mediated conflict resolution](/docs/mediated-conflict-resolution/) | What happens when two changesets conflict -- Policy-driven modes from automatic resolution up to human escalation, and Insights as the durable memory of what was decided. |
| [Trust model](/docs/trust-model/) | Earned, behavior-based standing as the long-term alternative to assigned Role grants. |
| [did:zz](/docs/did-zz/) | A unified decentralized identifier method for humans and agents alike. |
| [Agentic autonomy](/docs/agentic-autonomy/) | What's actually true about human/agent parity today, what's an external blocker zz can't solve alone, and one concrete step toward it. |
| [Credential handling](/docs/credential-handling/) | Moving off token-in-the-URL toward a real git credential helper and short-lived tokens. |
| [Ladder as a RAG knowledge graph](/docs/ladder-rag/) | Precisely-bounded context retrieval for agent tasks -- a major initiative, explicitly gated on validating its central empirical premise before further build-out. |
| [Contributors guide (sketch)](/docs/contributors-guide/) | A per-claim guide assembled live from Principles, Policy, Insights, and Charter -- sketched, not designed in full, pending Insights. |
| [Cost tracking (sketch)](/docs/cost-tracking/) | Tokens for agent work, hours for human work, on the same Ladder. |
| [The Hugging Face incident](/docs/hugging-face-incident/) | A corrected, primary-source account of the real incident this project's self-organization model traces back to -- what's confirmed, what a secondhand AI summary fabricated, and what does and doesn't map onto zz. |
| [Prior art](/docs/prior-art/) | Real precedents -- Debian's constitution, the Linux kernel's subsystem-maintainer tree, Apache's lazy consensus -- for specific mechanisms zz's governance design reuses rather than invents. |
| [Virtualized git (reference)](/docs/virtualized-git/) | Future storage-architecture options if git-native storage ever becomes a real bottleneck. Not scheduled. |

See also [Case studies](/docs/case-studies/) -- real bugs and design corrections found while actually building and demoing zz, including [the course correction](/docs/case-studies/charter-to-directed-selection/) that produced most of the pages above.
