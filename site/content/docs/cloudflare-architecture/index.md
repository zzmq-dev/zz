---
layout: docs
title: "How zz is built on Cloudflare"
description: "Workers, Durable Objects, and Artifacts as zz's actual execution substrate -- the specific implementation choices each one forced, and the limitations that shaped them."
---
# How zz is built on Cloudflare

zz's server side (`worker/`) is a single Cloudflare Worker, one Durable Object class, and Artifacts as the real git storage underneath both. This isn't a Worker that happens to call some Cloudflare services -- the protocol engine itself (claim/answer, Changesets, the Ladder) runs unmodified inside the Durable Object, the same `ToolDef.execute()` functions a local CLI run calls directly in-process. The architecture exists because of specific things Workers, Durable Objects, and Artifacts each make possible, and specific things each one doesn't -- this page goes through both, with the actual code and the actual bugs found running it live.

## The shape of it

- **Workers** (`worker/src/webApp.ts`, `worker/src/index.ts`) are the thin, stateless front door: JSON API routes, the web app's HTML, OAuth, and a byte-for-byte git smart-HTTP proxy.
- **One Durable Object per repo** (`MaintainerDO`) holds the real protocol state and is the only thing that ever mutates it.
- **Artifacts** is the actual git storage -- every repo zz hosts is a real git repository, reachable over plain `git clone`/`push`, with zz's own metadata (the Ladder) stored as git notes inside it rather than in a separate database.
- **D1** holds the one thing that's genuinely cross-repo: accounts, repo listings, RBAC role grants. Everything else is scoped to one repo's own Durable Object and its own Artifacts repo.

## Durable Objects: one instance is one repo, and that's the whole point

```jsonc
"durable_objects": { "bindings": [{ "name": "MAINTAINER_DO", "class_name": "MaintainerDO" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["MaintainerDO"] }]
```

Every call into a repo's protocol state routes through `env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(artifacts_name))` -- deterministic, name-keyed routing, so "this repo's Lane state" and "this one Durable Object instance" are the same thing by construction. That single property is what makes the protocol's atomicity guarantees free instead of engineered: a Durable Object processes its own requests one at a time, so two agents racing to claim the same Ask, or a coordinator merging while a review is mid-flight, can't actually interleave inside one repo's own instance. No lock, no transaction, no retry loop -- just routing the request to the right place and letting the platform's own single-threaded execution do the rest. (The session that wrote this page found the flip side of that property live: the CLI's own local-clone-based coordinator step has no such guarantee, since it's plain `git` commands against a shared directory on disk, not a Durable Object -- running two coordinator processes against one repo corrupted that shared working tree exactly because nothing was serializing them. The DO-backed side of the protocol was never at risk of this; the local CLI path doing comparable work without a DO behind it was.)

`MaintainerDO` itself is deliberately thin:

```ts
async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  return withBackend(this.backend, () => tool.execute(args));
}
```

It doesn't reimplement the protocol for the server side -- it reuses `agent/tools.ts`'s real tool implementations verbatim, over RPC instead of an in-process call, scoped to this instance's own storage via `AsyncLocalStorage`. Every RBAC check, the changeset_review gate, the merge backstop -- all of it runs the same code path whether the caller is a local `zz work` process or a remote CLI/TUI session. A short, explicit denylist (`run_in_sandbox`, the `gh_fetch_*` tools) exists for exactly the handful of tools that need a real filesystem, `child_process`, or the `gh` CLI -- none of which a Worker has -- so calling one by name fails with a clear reason instead of a confusing runtime crash.

### What a Durable Object's own constraints shaped

A DO instance is a JS object that cold-starts and gets evicted; nothing in memory survives that for certain, but its own storage does. `MaintainerDO.configure()` rebuilds its whole `Backend` object (and every in-memory cache on it) on any actual repo change, but is a no-op if called again for the same repo -- found necessary live, because every single CLI/TUI tool call hits this once per HTTP request, and rebuilding unconditionally was silently throwing away an in-memory cache on every call, defeating it entirely for any multi-call sequence spanning more than one request.

That split -- what's safe to keep only in memory for a DO instance's current warm lifetime, versus what needs to survive a cold start -- runs through the caching strategy on purpose:

- An in-memory `notesCache`, scoped to one `Backend` object, dedupes repeated git-notes checkouts of the *same* notes ref within one burst of calls (several Ladder rungs share one underlying ref; resolving a repo's Ladder tree used to re-fetch that ref from scratch for each one -- 5 redundant checkouts instead of 2, confirmed live on a small repo).
- The repo's root commit oid, and the whole resolved Ladder tree, are cached in the DO's own **durable** storage instead -- surviving eviction -- because re-deriving the root oid from a `repo.log({limit: 1000})` walk on every single Ladder-tab read was confirmed live as the dominant cost of that page, and the resolved tree itself is updated incrementally on every write rather than just invalidated, so a repo nobody's touching stays servable from cache indefinitely with no background warming needed.

## Artifacts: a real git repo, read and written with no clone and no filesystem

A Worker has no filesystem and no `child_process` -- there's no `git` binary to shell out to, and no working directory to `git clone` into even if there were. Artifacts gives a Worker-native binding for reading a repo's objects directly (`readCommit`/`readTree`/`readBlob`, `log`), which covers every read path with no cloning at all. Writing is the harder half, and it's where the actual engineering is:

```ts
export async function commitChangesetOnArtifacts(repoName, remote, token, repo, input) {
  const parentOid = await headOid(repo);
  const parentCommit = await repo.readCommit(parentOid);
  const flat = new Map(); await flattenTree(repo, parentCommit.treeHash, "", flat);
  const pending = new Map(/* flat's unchanged entries, plus input.files overlaid */);
  const fs = createMemFs();
  await git.init({ fs, dir, defaultBranch: "main" });
  const treeOid = await writeNestedTree(repo, fs, dir, pending);
  const commitOid = await git.writeCommit({ fs, dir, commit: { message: input.message, tree: treeOid, parent: [parentOid], ... } });
  await git.push({ fs, http, dir, url: remote, onAuth, ref: "main", remoteRef: "main" });
}
```

This never clones the repo's history. It reads the parent commit's tree natively and flattens it to a `path -> {oid, mode}` map (recursing into subdirectories itself, since the native `readTree` binding only returns one level at a time), overlays the actually-changed files on top, then rebuilds a *real, nested* git tree object from that merged map into a throwaway in-memory filesystem (`memFs.ts`) using `isomorphic-git`'s low-level object-writing calls -- `writeBlob`/`writeTree`/`writeCommit` -- never its higher-level clone/commit porcelain. Unchanged files are re-fetched by content and re-written, not referenced by their old oid, because that's what reproduces the identical blob oid (git blob hashing is purely content-addressed, confirmed live) without needing the original tree object to still exist unchanged. The result -- a handful of new objects representing one commit, not a repo's full history -- is what actually gets pushed, over `isomorphic-git`'s own HTTP transport. Reads use the Worker-native binding because there's nothing to clone into; writes use `isomorphic-git` for object construction because there's no `git` binary to invoke, and the combination only has to reconstruct the few objects a single commit actually needs, not the repo's whole history, every time.

### The limitation this surfaced: a real protocol bug in Artifacts' own git-upload-pack

Running this live, against a repo with real commit history, surfaced a genuine bug in Artifacts' own smart-HTTP implementation, not in anything built on top of it: an incremental `git fetch`/`pull` with several commits to negotiate corrupts the server's response (`fetch-pack: protocol error: bad band #78`). Traced with `GIT_TRACE_PACKET`, the server sends its final `NAK` as unwrapped plain text at exactly the point where `side-band-64k` framing is supposed to have already started -- a narrow, easy-to-miss protocol detail that a from-scratch reimplementation of git's smart-HTTP protocol (rather than shelling out to the real `git` binary, as GitHub/GitLab/self-hosted Gitea all do) is exactly positioned to get wrong on a rarely-exercised code path. A fresh clone has zero `have` lines to negotiate and never hits it; only a clone with real history to catch up on does. `zz repo clone` now sets `git config fetch.negotiationAlgorithm noop` by default -- skipping that negotiation path entirely, the same code path a fresh clone always takes -- as a deliberate, documented, temporary workaround, not a permanent design choice. (Full protocol trace: [case study](/docs/case-studies/git-incremental-fetch-sideband-error/).)

This is the clearest example on this page of the general shape of building on a newer, purpose-built platform rather than a mature one: the binding that lets a stateless Worker read and write real git objects with no filesystem at all doesn't exist anywhere else, and the price of that is hitting protocol edge cases a 20-year-old C implementation already worked out.

## Git notes as the Ladder's actual storage -- no separate schema for it

The Ladder (zz's structured, hierarchical knowledge graph -- what a file does, what a changeset changed, why) is stored as git notes, anchored to the commits and objects they describe, inside the same Artifacts repo as the code. Not a separate table in D1, not a separate KV namespace -- the same git object store, read back with the same native bindings, fetchable by any ordinary git client with `git fetch origin 'refs/notes/*:refs/notes/*'`. That choice follows directly from what a Durable Object and Artifacts already give for free: the DO's durable storage handles the *caching* layer this needs (above), but the data of record travels with the repo itself, in a format every git host and git client already understands, rather than in a bespoke store only zz's own server can read.

## D1: the one genuinely cross-repo store

Everything above is scoped to one repo's own Durable Object instance -- which is correct for Lane/Ask/Ladder state, but wrong for accounts, repo listings, and RBAC role grants, none of which belong to any single repo. Those live in D1 (`zz-accounts`) instead, queried directly from the stateless Worker layer, not through any Durable Object. The split isn't arbitrary: it's "per-repo state, strongly consistent within that repo" (Durable Object) versus "global state, queried across repos" (D1) -- using each store for the shape of consistency it actually has to offer, not using a Durable Object as a general-purpose database or D1 as a coordination mechanism.

## Workers: the thin, stateless layer holding it together

Everything in `worker/src/webApp.ts` -- the JSON tool-call API, the web app's own HTML rendering, OAuth, repo/agent/RBAC management -- runs as an ordinary stateless Worker, with no state of its own beyond what it reads from D1 or forwards to a Durable Object or Artifacts. The one piece of this worth calling out specifically is `handleGitPack`: zz repos are reachable by plain `git clone`/`push` because this handler is a byte-for-byte pass-through, forwarding a client's `git-upload-pack`/`git-receive-pack` request body straight to Artifacts' own endpoint and streaming the response straight back, stripping only the hop-by-hop headers (`content-length`/`content-encoding`/`transfer-encoding`) the Workers runtime needs to set correctly itself. It never inspects or rewrites the pack bytes -- which is exactly how the case study above could establish, with certainty, that the `bad band #78` bug was in Artifacts' own git implementation and not in anything zz added on top of it.

## Why this split, overall

The three services aren't interchangeable, and the design leans on what each one is actually good for: Workers for stateless routing and protocol-free passthroughs, a Durable Object per repo for the one thing that genuinely needs strong, serialized consistency (the protocol's own mutations), Artifacts for real git storage reachable by real git clients, and D1 for the global, cross-repo lookups that don't fit either of the other two. The limitations found along the way -- Artifacts' own protocol bug, the filesystem/subprocess gap Workers impose on anything touching git directly, the caching discipline a Durable Object's cold-start/eviction lifecycle demands -- weren't worked around by reaching for a different platform; each one shaped a specific, narrow piece of the implementation instead, documented here and in the [case studies](/docs/case-studies/) this session's live debugging actually produced.
