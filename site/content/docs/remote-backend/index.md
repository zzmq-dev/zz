---
layout: docs
title: "Remote backend"
description: "Moving the engine onto Cloudflare Artifacts and Durable Objects, without losing the local-only path."
---
# Remote backend

Everything built so far (`app/engine/`, `app/agent/`, the `zz` CLI) runs against a local git clone and flat files under `.zz/`. This doc specs out running the same engine against Cloudflare Artifacts (the repo itself) and Durable Objects (Lane/Ask/Answer state), reachable through the same tool calls `zz work` already uses.

**The local path keeps working.** This isn't a one-way migration. Running `zz` with no remote configured stays exactly what it is today: a local clone, local `.zz/` state, local git notes. Configuring a remote switches the same commands onto Cloudflare infrastructure, behind the same interface. This mirrors `engine/model.ts`'s `ModelBackend` split (local Ollama by default, nothing forced) -- the same pattern, one level down the stack.

## What's already positioned for this

`engine/gitNotes.ts` and `engine/ingest.ts`'s `walkFileTree` use `isomorphic-git`, not the real `git` binary, specifically because it's the one git implementation that runs inside a Cloudflare Worker (no `child_process`, no native addon loading there) -- a decision made for exactly this move, confirmed now: Cloudflare Artifacts' write path is **only** a real `git push` over the smart HTTP protocol (no binding method writes a blob/tree/commit/ref directly). Since `isomorphic-git` can construct and push real commits, trees, and notes refs on its own, the Ladder's git-notes mechanism doesn't need to change shape at all, just where the clone it's operating on actually lives.

## Primitive mapping

| What exists today | Where it lives locally | Cloudflare equivalent |
| --- | --- | --- |
| The repo's commit history, file content | A real local clone (`demo-repos/<repo>`) | An [Artifacts](https://developers.cloudflare.com/artifacts/) repo, created via `env.ARTIFACTS.create()` |
| The Ladder (`engine/ladderNotes.ts`) | Git notes in that local clone | The same notes refs, pushed to the Artifacts repo over the git protocol |
| Lane/Ask/Answer state (`engine/store.ts`) | Flat JSON under `.zz/lanes/*.json` | One Durable Object per repo ("the Maintainer DO"), SQLite-backed storage |
| The agent tool surface (`app/agent/tools.ts`) | In-process function calls | The same tool names, served as HTTP/MCP endpoints by a Worker in front of the Maintainer DO |
| `zz work`'s agent loop | Calls tools directly | Calls the same tools over HTTP against the Worker |

Nothing in `engine/ladder.ts`'s `Rung` shape, `engine/types.ts`'s `Lane`/`AskEntry`/`AnswerEntry`, or `app/agent/tools.ts`'s tool signatures needs to change. What changes is which concrete functions `readLane`, `writeLane`, `readAnchor`, and `writeLadder` actually call.

## The `Backend` interface

One new seam, `engine/backend.ts`, the same shape `ModelBackend` already established:

```ts
export interface Backend {
  // git content
  cloneOrConnect(repo: string): Promise<void>;
  listCommits(repo: string): Promise<CommitRow[]>;
  diffCommit(repo: string, sha: string): Promise<FileChangeRow[]>;
  readFileAtCommit(repo: string, sha: string, path: string): Promise<string>;

  // Ladder (git notes)
  readAnchor(repo: string, path: string): Promise<EmbeddedRung | null>;
  writeLadder(repo: string, rung: Rung): Promise<void>;
  appendRepoChildren(repo: string, children: { path: string; kind: RungKind }[]): Promise<void>;

  // Lane/Ask/Answer
  readLane(repo: string, laneId: string): Promise<Lane | null>;
  writeLane(repo: string, lane: Lane): Promise<void>;
  listLanes(repo: string): Promise<Lane[]>;
}
```

`LocalBackend` is today's code, unchanged, moved behind this interface -- a pure refactor, no behavior change, step one below. `CloudflareBackend` is an HTTP client that calls a Worker; the Worker is where `env.ARTIFACTS` and the Maintainer DO actually live. `resolveBackend()` picks one based on config (`ZZ_BACKEND=local|cloudflare`, default `local`), the same way `engine/model.ts`'s `resolveModelBackend()` already picks a model.

## The Worker side

One Worker, one Durable Object class (`MaintainerDO`, one instance per repo):

- **Git operations** go through `env.ARTIFACTS`: `create()` once per repo (or `get()` if it already exists), then real git clone/fetch/push against the returned remote URL using a token from `repo.createToken()`, via `isomorphic-git` running inside the Worker -- the same library, the same calls, just targeting an Artifacts remote instead of a local path.
- **Lane/Ask/Answer reads and writes** go straight to the DO's own SQLite storage (`ctx.storage.sql`), replacing `engine/store.ts`'s file reads/writes one for one.
- **The tool surface** (`git_log`, `git_diff`, `ladder_read`, `ladder_write_rung`, `lane_propose`, `ask_post`, etc.) is exposed as Worker routes with the same names and parameter shapes already defined in `app/agent/tools.ts` -- `zz work` running against a configured remote calls `POST /tools/ladder_write_rung` instead of importing the function directly, through the exact same `ToolDef.execute` contract on the client side.

## Open questions

- **Push cost and reliability against Artifacts specifically.** `isomorphic-git`'s push path is proven locally; it hasn't been tested against Artifacts' real smart-HTTP endpoint. A rung write today is a cheap local git-notes commit; over the network, with a freshly-minted token per write, it's a real round trip. Worth measuring before assuming today's write-per-rung granularity still makes sense remotely -- batching several rung writes into one push may turn out to matter.
- **Does the DO keep its own working clone, or fetch from Artifacts on demand?** Keeping a persistent clone (DO-local disk, if available, or re-cloning into Worker memory per request) avoids re-fetching the whole history every time, but is itself state that needs to stay in sync with Artifacts as the source of truth. Re-fetching on demand is simpler and avoids a second copy drifting, at the cost of latency.
- **Diffing without a full clone.** The Workers binding exposes `readTree`/`readBlob`/`readCommit` (read-only) but no `diff(shaA, shaB)`. `engine/ingest.ts`'s `commitFileChanges` shells to real `git diff` locally; the remote equivalent needs either a real clone to diff against locally (isomorphic-git has this), or a hand-rolled tree-diff using the binding's read methods directly, without a clone at all. The second is cheaper per call but is new code, not a port of something that exists.
- **Token lifecycle.** `createToken(scope, ttl)` issues short-lived credentials. The Maintainer DO needs to mint and rotate these itself for whatever's pushing (the agent loop, a human's CLI) rather than a long-lived credential sitting in a config file somewhere.
- **Cost and access.** Artifacts requires a Workers Paid plan and is still beta access as of this writing -- confirm current account access before assuming any of this is deployable today, not just specable.

## Build sequencing

1. Define `Backend`, move the existing code behind `LocalBackend` with no behavior change. Verify: everything built so far (`zz ladder build`, `replay-commits`, `work`) still works identically, now through one extra indirection.
2. Stand up the Worker and `MaintainerDO` against a real Cloudflare account, with just enough of the interface implemented to clone a real repo into a real Artifacts repo and read it back -- prove the git side before the Lane/Ask side.
3. Add Lane/Ask/Answer storage on the DO's SQLite backend; prove `proposeLane`/`ask`/`answer` round-trip correctly against it.
4. Expose the tool routes, add `CloudflareBackend` as an HTTP client, add the `ZZ_BACKEND` switch.
5. Re-run the exact same bounded `zz work` test already used for the local in-process tools (one not-yet-onboarded commit) against the remote backend, and confirm the resulting Ladder content matches what the local run produces for the same commit.
