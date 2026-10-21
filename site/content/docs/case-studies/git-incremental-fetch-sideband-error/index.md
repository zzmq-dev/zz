---
layout: docs
title: "Case study: a corrupted incremental git fetch"
description: "fetch-pack: protocol error: bad band #78 -- a real bug in Cloudflare Artifacts' own git-upload-pack, found live while recording the demo."
---
# Case study: a corrupted incremental git fetch

Found live, 2026-10-14, while rehearsing the [Two roles](/docs/demos/two-roles/)/[Bulk Asks](/docs/demos/bulk-asks/) demo stages against a real clone of `mathkit`. Recorded here because the root cause is confirmed, but the actual fix lives outside this repo -- in Cloudflare Artifacts' own server-side git implementation, which this project doesn't control.

## Symptom

```
$ git pull
fetch-pack: protocol error: bad band #78
fatal: protocol error: bad pack header
```

A plain `git pull` on an existing clone of `zzmq.dev@gmail.com/mathkit`, several commits behind the real `main`.

## What it wasn't

- **Not local corruption.** `git fsck --full` on the affected clone came back completely clean -- every object, every ref, no errors.
- **Not an exception server-side.** `wrangler tail` showed the request completing normally (`POST .../mathkit/git-upload-pack - Ok`) both times it was captured live. The Worker never threw.
- **Not this project's own proxy code.** `handleGitPack` (`worker/src/webApp.ts`) is a byte-for-byte pass-through: it forwards the client's request body to the Artifacts backend's own `git-upload-pack` endpoint and streams the response straight back, with only hop-by-hop headers (`content-length`/`content-encoding`/`transfer-encoding`) stripped so the Workers runtime can set its own correct ones. It never touches the pack bytes themselves.

## Root cause

Confirmed directly with `GIT_TRACE_PACKET=1 GIT_TRACE=1 git pull`. The client negotiates `side-band-64k` (every subsequent line from the server is supposed to be wrapped in a channel-number byte: `1` = data, `2` = progress, `3` = error) and sends its "I already have these commits" (`have ...`) lines -- in the failing case, fifteen of them, since the clone was that far behind:

```
packet:   fetch-pack> have ed71648ffe9284c212a65cf222a5d5cbe322a224
packet:   fetch-pack> have a01a50acac07d46c3f18f22b2e86a9c7ea406b17
... (13 more) ...
packet:   fetch-pack> 0000
packet:   fetch-pack< ACK ed71648ffe9284c212a65cf222a5d5cbe322a224
packet:   fetch-pack> done
packet:          git< 0000
packet:     sideband< NAK
fetch-pack: protocol error: bad band #78
fatal: protocol error: bad pack header
```

The server's response starts with the literal text `NAK` -- the old, pre-side-band acknowledgment line. But the client already negotiated side-band framing, so it reads the response's first byte as a *channel number*, not text. `N` is ASCII 78. `bad band #78` is git reporting exactly that: a byte that isn't `1`, `2`, or `3` where a channel indicator belongs.

In other words: for an **incremental fetch with multiple `have` lines**, the Artifacts backend's git-upload-pack sends a response in the *wrong protocol dialect* for what it negotiated -- plain, unwrapped text where the client expects every byte wrapped in side-band framing.

## Why this happens -- and why GitHub/GitLab/etc. don't have it

The trace line above is labeled `sideband< NAK` by git's own client, not by us -- meaning git's parser had *already* switched into side-band demultiplexing mode at that exact point. That's not a guess; it's what the protocol spec calls for: once `side-band-64k` is negotiated, the framing is supposed to start at the **final ACK/NAK of the negotiation phase itself** (sent as band-1 data, `\x01NAK\n`), not just at the pack bytes that follow it. Artifacts' server sent the old, unwrapped `NAK\n` at exactly the boundary where both sides are supposed to have already switched formats.

That's a narrow, easy-to-miss protocol detail -- specifically the kind of thing that slips through when a git-server implementation has two separate code paths: one for "fresh clone, nothing to negotiate, stream everything wrapped from byte one" (simple, and the first thing anyone tests), and a second, more complex one for "the client already has history, do a real have/ack negotiation" -- a path that's exercised far less during initial development and easy to leave on the pre-side-band format by mistake.

Virtually every mainstream git host (GitHub, GitLab, Bitbucket, self-hosted Gitea, ...) runs the real, official `git` C binary as `git upload-pack` under the hood -- decades of battle-testing on exactly this protocol nuance. Cloudflare Artifacts is a much newer, purpose-built platform, almost certainly reimplementing the smart-HTTP pack protocol from scratch to fit its own storage model rather than shelling out to real git -- exactly the kind of implementation most likely to diverge from spec on a rarely-exercised negotiation path. (Reasoned from the protocol spec and this trace, not from Cloudflare's own source, which isn't available to inspect.)

## Why a fresh clone never hits this

A `git clone` has zero `have` lines -- there's nothing to negotiate, so it takes a different, simpler server-side code path that correctly applies side-band framing from the first byte. Every reproduction attempt that used a fresh clone (or a clone only a commit or two behind) worked perfectly; the bug only ever showed up on a clone with a real backlog of commits to negotiate against.

## The actual fix: skip negotiation entirely

```
git config fetch.negotiationAlgorithm noop
```

This tells git to skip the "tell the server what I already have" negotiation altogether -- the same code path a fresh clone takes (zero `have` lines), confirmed above to always work. Tested live on the exact clone that was reliably failing (15 commits behind): a full `git pull` with this set succeeded cleanly, fast-forwarding through everything with no error. Unlike "pull often" below, this avoids the bug completely, regardless of how far behind a clone gets.

The real tradeoff: without negotiation, the server can't compute as small a delta, so a fetch under this setting likely transfers more data than a normal incremental one would -- not a problem for a repo this size, but worth knowing on a large, long-lived one.

**`zz lane checkout` now sets this on every new checkout by default**, alongside its existing `pull.rebase true` -- see [Git compatibility](/docs/git-compatibility/#why-zz-lane-checkout-sets-fetchnegotiationalgorithm). This is temporary, pending Cloudflare actually fixing the bug; once that happens, `zz lane checkout` will stop setting it, and an existing clone can drop it itself at any time with `git config --unset fetch.negotiationAlgorithm`.

`git -c protocol.version=0 pull` does **not** help -- tested live, still fails identically. Side-band negotiation is independent of the v0/v2 wire protocol switch, so this was never going to route around it.

## Weaker mitigation: pull often, don't let a backlog build

Before the fix above was found, this was the standing advice -- still true, just no longer necessary if `fetch.negotiationAlgorithm noop` is set. Tested live, same session: a `git pull` with only a handful of commits to negotiate (one, then a few more shortly after) succeeded cleanly every time, on a repo with workers actively merging in the background. The clone that actually hit the bug (`mathkit-bad`) was 15 commits behind -- a real backlog, not a quick catch-up. Not a guaranteed fix (no exact commit-count threshold is confirmed, just that "a little behind" works and "far behind" doesn't) -- the setting above is the better answer now.

## If you've already fallen behind and hit it on an old clone

Easiest fix: `git config fetch.negotiationAlgorithm noop` on that same clone, then pull again -- no need to re-clone. Re-cloning also still works, if you'd rather start fresh:

```
mv ~/workspace/mathkit ~/workspace/mathkit-broken
zz lane checkout zzmq.dev@gmail.com/mathkit ~/workspace/mathkit
```

If you're actively working off a clone that starts failing this way mid-session, the safest sequence is: note anything uncommitted, re-clone fresh, then reapply just that uncommitted work on top.

## Status

Worked around (`fetch.negotiationAlgorithm noop`, now a `zz lane checkout` default), not fixed -- can't be, from this codebase. The underlying bug is in Cloudflare Artifacts' own git-upload-pack, not in anything `zz` ships. Follow-up options, for later:

- File it with Cloudflare directly, with this page's protocol trace as the repro.
- Once Cloudflare actually fixes it: remove `fetch.negotiationAlgorithm noop` from `zz lane checkout`'s defaults, and update this page and [Git compatibility](/docs/git-compatibility/#why-zz-lane-checkout-sets-fetchnegotiationalgorithm) to say so, with `git config --unset fetch.negotiationAlgorithm` for an existing clone that still has it set.
- Pin down the actual threshold (how many commits/`have` lines before it reliably triggers), rather than the rough "a little behind is fine, a lot isn't" observed so far -- mostly academic now that the real fix avoids the question entirely, but still an open question about the underlying bug.
- Watch for whether this is specific to repos that have had many delegated Lanes (as `mathkit` has, by this point in the demo chain), or just to fetch distance.
