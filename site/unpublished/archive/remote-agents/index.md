---
layout: docs
title: "Remote agents"
description: "Running zz work unattended, off your laptop: one runner interface, several implementations, with a native Cloudflare Durable Object as the primary one."
---
# Remote agents

> **Archived.** This is a design or planning document from earlier in the project. It records the reasoning at the time it was written and may describe plans that changed or were never built. See the [Archive](/docs/archive/) index for context, or the [Overview](/docs/overview/) for how `zz` works today.

`zz work` is the loop that makes an agent an agent: poll for claimable Asks, claim one, drive a model through it, answer it, repeat. Today that loop runs as a process on whoever's machine typed the command. This doc plans out running the same loop **unattended**, somewhere that isn't a laptop, so a repo's agents keep working with nobody's terminal open.

The goal is not one hosting answer but a **runner interface** with several implementations behind it, chosen per launch:

```
zz work --provider workers-ai --on cloudflare --repos owner/repo
zz work --provider groq       --on docker     --repos owner/repo
zz work --provider ollama     --on gpu-box    --repos owner/repo
```

Three kinds of runner matter, and they're deliberately different in shape, not just in where they're hosted:

1. **Native Cloudflare** -- a Durable Object that *is* the loop, using Workers AI for inference. Not "zz in a container on Cloudflare"; the primary implementation, and the one the rest of the project is built around.
2. **Generic Docker** -- today's CLI, unmodified, in an image any container host can run. The portability baseline.
3. **Co-located inference** -- runners where the model runs in the same environment as the loop (a GPU container, a homelab box, an Apple Silicon machine), so inference is a local call instead of a network hop to an external API.

## What the loop depends on today

Most of `zz work` is already location-independent. In remote mode (the default), every Lane/Ask/Ladder mutation goes through `callRemoteTool` to `MaintainerDO`; the model is an HTTPS call (or a local Ollama one); identity can come from `ZZ_ID`/`ZZ_ID_FILE` without a browser login; `--stdio` skips the TUI. What actually ties it to a real machine:

| Dependency | Where | Why it matters off-laptop |
| --- | --- | --- |
| A real `git` binary and a disk | `cli/lib/repo.ts` (`ensureCloned`, `syncClone`), `agent/scriptedWork.ts` (`ls-tree`, `rev-parse`), `agent/threeWayMerge.ts` (`git merge-file`) | No `child_process` in a Worker. Fine in any container. |
| `run_in_sandbox` | `agent/tools.ts` | Creates a `git worktree` and runs model-written code via `/bin/sh`. Needs a real OS sandbox wherever it runs. The Worker already skips it by design. |
| An infinite 1s poll loop | `cli/commands/work.ts` `mainLoop` | Free on a laptop; on metered infrastructure it keeps a machine awake forever doing nothing. |
| `--as` ephemeral identity | `cli/lib/identity.ts` | Mints a token and revokes it on exit -- correct for an interactive session, wrong for a runner that should outlive the CLI that launched it. |

## The runner interface

Every implementation answers the same four questions, so `--on <target>` is just a lookup:

```ts
export interface Runner {
  name: string; // "cloudflare" | "docker" | "fly" | "gha" | "gpu-box" | ...
  launch(spec: RunnerSpec): Promise<RunnerHandle>;
  stop(id: string): Promise<void>;
  list(): Promise<RunnerHandle[]>;
  logs(id: string, opts?: { follow?: boolean }): AsyncIterable<string>;
}

export interface RunnerSpec {
  agent: string;              // acting identity, e.g. "alice[reviewer]"
  repos: string[];
  scope: WorkScope;
  provider: Provider;
  model?: string;
  maxTurns?: number;
  mode: "serve" | "drain";    // run forever, or exit once nothing is claimable
}
```

The CLI side (`zz work --on <target>`, plus `zz runners ls|logs|stop`) mints a **long-lived, scoped, revocable runner token** for the acting agent and hands it to the runner as its identity -- never the human's own credentials, and never an `--as` ephemeral token that the launching process would revoke on exit. Provider keys (when a provider needs one) are supplied at launch and stored by the runner implementation, not baked into an image.

`zz top` gains a Runners view: every runner the logged-in user owns, where it's running, what it's working on, and its live log stream.

## 1. Native Cloudflare runner (primary)

A Durable Object that replicates `zz work`'s behavior natively, sitting next to `MaintainerDO` in the same Worker, with Workers AI as its default model. Nothing about it shells out, and nothing about it polls.

**One `RunnerDO` per runner.** Created by `POST /api/runners` (the `--on cloudflare` launch call); its SQLite storage holds the `RunnerSpec`, the runner token, the current Ask, and the in-flight conversation. Built on the Agents SDK's `Agent` class, which supplies the state, scheduling, and WebSocket plumbing (logs and status stream straight to `zz top` and the web app) this would otherwise hand-roll.

**Event-driven, not polling.** `MaintainerDO` already sees every `ask_post` and every answer that unblocks a `depends_on`. It notifies subscribed `RunnerDO`s for that repo directly (a DO-to-DO RPC), and the runner wakes, runs `claimableAcrossRepos` for itself, and claims. An idle runner costs nothing: no loop, no container, no alarm firing every second -- just a slow safety-net alarm in case a notification is ever missed.

**Each turn is a durable step.** A single Ask can run up to 60 model turns, each a model call plus tool calls. Driving that from one long DO invocation risks losing the whole attempt to an eviction or deploy. Instead each claimed Ask runs as a [Workflow](https://developers.cloudflare.com/workflows/), one step per model turn, so a restart resumes from the last completed turn instead of starting over -- the same guarantee `alreadyClaimed` gives the CLI today, made much finer-grained.

**Inference via the Workers AI binding.** `--provider workers-ai` uses `env.AI` directly: no API token, no account-id config, no egress, billed to the same account the rest of zz runs on. This replaces today's `cloudflare` provider (which calls the Workers AI REST API with `CLOUDFLARE_API_TOKEN` from outside). External providers (`groq`, `gemini`) stay available from the native runner too, with their keys held in Secrets Store -- but the binding is the default because it's the one with zero configuration.

**Git without a binary.** The pieces already exist in the Worker: `isomorphic-git` against Artifacts, and `memFs.ts` as the in-memory filesystem. What has to change for the scripted flows (`agent/scriptedWork.ts`) to run here:

- `ls-tree` / `rev-parse` / reading file content at a commit become `isomorphic-git` (or Artifacts binding `readTree`/`readBlob`) calls behind the same `Backend`-style seam `engine/backend.ts` already established.
- `threeWayMerge` drops `git merge-file` for a pure-JS diff3 (e.g. `node-diff3`), so conflict resolution runs anywhere.
- No persistent clone: the runner reads what it needs from Artifacts per Ask, which is what the remote path already treats as the source of truth.

**`run_in_sandbox` via the Sandbox SDK.** The one thing that genuinely needs an OS. The native runner delegates it to Cloudflare's [Sandbox SDK](https://developers.cloudflare.com/sandbox/): spin up a sandbox, check out the repos at the right commits, write the proposed files, run the command, return stdout/exit code, tear down. A container exists only for the seconds a test run takes, not for the lifetime of the agent.

**Shape of the code.** The goal is shared code, not a fork of `zz work`: the per-Ask logic (`runClaimedAsk`, the scripted flows, `runAgent`) gets a small set of injected capabilities -- `callTool`, `readRepo`, `runSandbox`, `chat`, `log` -- that the CLI fills with local implementations and `RunnerDO` fills with Worker ones. Most of that seam already exists (`callTool`/`executeTool` are already injected for remote mode); this finishes the job.

## 2. Generic Docker runner

The portability baseline: today's CLI in an image, so `zz work` runs unattended on any container host with no Cloudflare dependency in the loop itself.

```
docker run -e ZZ_ID=... -e GROQ_API_KEY=... ghcr.io/<owner>/zz \
  work --stdio --provider groq --repos owner/repo --drain
```

The image is `node` + `git` + the published `zz` package, nothing more. `--on docker` launches it locally (useful mostly for testing the image); thin per-host runners wrap the same image:

| Target | Notes |
| --- | --- |
| `fly` | Fly Machines can suspend and autostart, a reasonable fit for `serve` mode. |
| `gha` | A `workflow_dispatch`/scheduled GitHub Actions job running `--drain`. 6-hour cap; good for "work the queue, then exit". |
| `railway`, `render`, a VPS + systemd | Always-on, flat cost, simplest possible operations. |
| Cloud Run Jobs, ECS/Fargate | `--drain` as a job; `serve` mode works but pays for idle time. |

Two CLI changes make this viable, and both are worth doing regardless of runner:

- **`--drain`**: exit once nothing is claimable, instead of polling forever. This is what makes scale-to-zero and job-style hosts work.
- **A long-lived runner token** (above), passed as `ZZ_ID`.

## 3. Co-located inference runners

The model runs inside the runner's own environment, so inference is a local call rather than a network round trip to a hosted API. This is the shape `--provider ollama` already has on a laptop -- these runners just put it somewhere that stays on.

Same Docker image as above, plus an inference server in the same machine or pod, with the provider pointed at `localhost`:

| Target | Inference | Notes |
| --- | --- | --- |
| `gpu-box` (any GPU container host: Fly GPUs, RunPod, Modal, a cloud VM) | Ollama, vLLM, or llama.cpp server as a sidecar | The model is pulled once into a volume. The cost is the GPU, idle or not -- `--drain` plus host autostop matters most here. |
| `homelab` (a box you own, via SSH or a systemd unit) | Ollama / llama.cpp | Zero marginal cost; this is the laptop setup, made permanent. |
| `apple-silicon` (a Mac mini or similar) | Ollama or MLX | Large unified memory makes bigger local models practical. |

This needs one generalization on the provider side: today's `ollama` provider already takes `ZZ_OLLAMA_HOST`, and vLLM and llama.cpp both expose an OpenAI-compatible endpoint, so a generic `openai-compatible` provider (base URL + model) covers all three without one backend each.

The native Cloudflare runner is co-located inference too, in effect: the Workers AI binding runs on the same network as the DO calling it.

## Safety requirements, every runner

- **`run_in_sandbox` must not inherit the runner's environment.** Today it calls `execFileSync` without an `env`, so model-written code can read whatever the parent process holds -- on an unattended runner, that's the runner token and any provider API key. Pass a minimal, explicit `env` (and on the Docker and co-located runners, run sandboxed commands as an unprivileged user with no network unless the command needs it). This is worth fixing for the laptop path too.
- **Runner tokens are scoped to the acting agent and the runner's repos,** and revocable from `zz runners stop` and the web app independently of the human's own session.
- **Hard spend limits** per runner: a max Asks per hour and max turns per Ask, enforced by the runner itself rather than trusting the model to stop.

## Build sequencing

1. **CLI groundwork.** `--drain`, the sandbox `env` fix, long-lived scoped runner tokens, and an `openai-compatible` provider. Verify: `ZZ_ID=... zz work --stdio --drain` on a clean machine works the queue and exits.
2. **Docker image + `--on docker`.** Publish the image; prove one Ask end to end in a container with no local state.
3. **Runner interface + `zz runners`.** The `Runner` interface, `ls`/`logs`/`stop`, and the Runners view in `zz top`, with `docker` as the first implementation.
4. **Extract the per-Ask capability seam** (`callTool`, `readRepo`, `runSandbox`, `chat`, `log`) so the same per-Ask code runs under both the CLI and a Worker. Replace `git merge-file` with a pure-JS diff3.
5. **`RunnerDO` + `--on cloudflare`.** Workers AI binding, Workflow-per-Ask, Sandbox SDK for `run_in_sandbox`. First with a slow alarm loop, then switched to event-driven wakeups from `MaintainerDO`.
6. **Co-located runners** (`gpu-box`, `homelab`) and host-specific Docker wrappers (`fly`, `gha`) as demand dictates.

## Open questions

- **Workers AI tool-calling quality.** The scripted flows exist precisely because models struggled to assemble large nested tool-call arguments. Which Workers AI models hold up through the generic loop's remaining Ask kinds needs measuring, not assuming.
- **Sandbox SDK cold start and checkout cost.** A test run needs the repo (and its dependencies) checked out at specific commits. Whether that's a fresh clone from Artifacts per run or a warm, reused sandbox per runner is a cost/latency trade-off to measure.
- **Workflow step granularity.** One step per model turn is the obvious unit; whether tool calls within a turn also need to be their own steps depends on how often a turn gets interrupted mid-tool-call in practice.
- **Who pays.** A native runner bills inference to the account hosting zz. For third-party users that means either bring-your-own Cloudflare account or a metered allowance -- a product decision, not just an engineering one.
