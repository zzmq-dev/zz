---
layout: docs
title: "Case studies"
description: "Real bugs and design decisions found and documented while building and demoing zz live."
---
# Case studies

Each of these came out of actually running `zz` -- rehearsing a demo, hitting a real error, tracing it to a root cause, and writing it up with the evidence rather than a guess. Some are bugs in Cloudflare's own platform that `zz` works around; some are gaps in `zz` itself, fixed or still open. The [How zz is built on Cloudflare](/docs/cloudflare-architecture/) page is the odd one out here -- not a bug writeup, but the same "here's the actual code and the actual tradeoff" treatment applied to the whole Workers/Durable Objects/Artifacts stack zz runs on.

| Page | What it covers |
| --- | --- |
| [How zz is built on Cloudflare](/docs/cloudflare-architecture/) | Workers, Durable Objects, and Artifacts as the real execution substrate -- the specific implementation choices each one forced, and the limitations that shaped them. |
| [Corrupted incremental git fetch](/docs/case-studies/git-incremental-fetch-sideband-error/) | A real `fetch-pack: protocol error: bad band #78` bug in Cloudflare Artifacts' own git-upload-pack, root-caused with a full protocol trace and worked around in `zz repo clone`'s defaults. |
| [Conflict resolution silently drops tasks](/docs/case-studies/merge-conflict-resolution-silently-drops-tasks/) | A failed `resolve_conflict` gives up and denies with no retry and no visible signal -- a real gap in zz's own protocol logic, not yet fixed. |
| [Concurrent coordinators corrupt a shared clone](/docs/case-studies/concurrent-coordinators-corrupt-shared-clone/) | Running two maintainer-scope `zz work` processes against the same repo races on one shared local git clone -- not yet fixed; run at most one coordinator per repo for now. |
