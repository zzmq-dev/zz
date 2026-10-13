---
layout: docs
title: "Archive"
description: "Design documents, plans, and early sketches from the zz build, kept for reference."
---
# Archive

These pages were written while `zz` was being designed and built. Each one captures the thinking at a point in time, as a plan for what to build next, a sketch of an interface before it existed, or a working log of a subsystem under construction. Much of it has since been implemented, changed, or dropped.

The current docs describe how `zz` works today. Use these pages for background on why something was built the way it was. They may be removed in the future.

| Page | What it covers |
| --- | --- |
| [Competition plan](/docs/archive/competition-plan/) | The original scope and schedule for the Cloudflare competition entry. |
| [CLI sketch](/docs/archive/cli-sketch/) | The command set imagined before the CLI existed. The [CLI reference](/docs/cli/) documents the commands that shipped. |
| [Data format design](/docs/archive/data-format-design/) | The planned `.zz/` directory, `policy.yaml`, and trust files. The [Data format](/docs/data-format/) page documents what is stored today. |
| [Ladder design](/docs/archive/ladder-design/) | A working log from building the first Ladder against supertest, including bugs found along the way. |
| [Remote backend](/docs/archive/remote-backend/) | The plan for moving the engine from a local clone onto Cloudflare Artifacts and Durable Objects. |
| [Remote agents](/docs/archive/remote-agents/) | A plan for running `zz work` unattended on Cloudflare, Docker, or a GPU host. Not yet built. |
