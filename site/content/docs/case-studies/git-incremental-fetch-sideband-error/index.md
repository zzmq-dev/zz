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

## Why a fresh clone never hits this

A `git clone` has zero `have` lines -- there's nothing to negotiate, so it takes a different, simpler server-side code path that correctly applies side-band framing from the first byte. Every reproduction attempt that used a fresh clone (or a clone only a commit or two behind) worked perfectly; the bug only ever showed up on a clone with a real backlog of commits to negotiate against.

## Prevention: pull often, don't let a backlog build

Tested live, same session: a `git pull` with only a handful of commits to negotiate (one, then a few more shortly after) succeeded cleanly every time, on a repo with workers actively merging in the background. The clone that actually hit the bug (`mathkit-bad`) was 15 commits behind -- a real backlog, not a quick catch-up.

So in a session with several workers merging continuously (as in [Two roles](/docs/demos/two-roles/) onward), pulling after every merge or two -- rather than letting changes pile up and catching up all at once -- is a real, tested mitigation. Not a guaranteed fix (no exact commit-count threshold is confirmed, just that "a little behind" works and "far behind" doesn't), but it meaningfully reduces how often this actually comes up.

`git -c protocol.version=0 pull` does **not** help -- tested live, still fails identically. Side-band negotiation is independent of the v0/v2 wire protocol switch, so this was never going to route around it.

## Workaround, once you've already fallen behind and hit it

Re-clone instead of trying to repair the existing one -- the real repo on the server is fine, nothing is lost:

```
mv ~/workspace/mathkit ~/workspace/mathkit-broken
zz repo clone zzmq.dev@gmail.com/mathkit ~/workspace/mathkit
```

If you're actively working off a clone that starts failing this way mid-session, the safest sequence is: note anything uncommitted, re-clone fresh, then reapply just that uncommitted work on top.

## Status

Not fixed -- can't be, from this codebase. The bug is in Cloudflare Artifacts' own git-upload-pack, not in anything `zz` ships. Follow-up options, for later:

- File it with Cloudflare directly, with this page's protocol trace as the repro.
- Pin down the actual threshold (how many commits/`have` lines before it reliably triggers), rather than the rough "a little behind is fine, a lot isn't" observed so far.
- Watch for whether this is specific to repos that have had many shards/forks (as `mathkit` has, by this point in the demo chain), or just to fetch distance.
