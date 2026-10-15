// `zz work`: a single headless work-loop command any agent runs,
// regardless of role. It doesn't know in advance whether it's a
// coordinator or a contributor on any given repo -- it only knows which
// repos it cares about (cli/lib/config.ts) and its own identity. The
// backend (today: claimableAcrossRepos over the local .zz/ state; later:
// the same call against a remote Backend) hands back only what that
// identity is actually permitted to act on. `--scope` is a further,
// purely client-side filter on top of that (e.g. so a coordinator can
// focus on coordinator-level work without also hoovering up contributor
// asks it's merely allowed to pick up).
import React from "react";
import { execFileSync } from "node:child_process";
import { render } from "ink";
import { ensureCloned, resolveRepo, syncClone, type ResolvedRepo } from "../lib/repo.js";
import { readConfig } from "../lib/config.js";
import { ask, answer, ASK_SCOPE, mergeLaneLadder, proposeLane } from "../../engine/lane.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { resolveBackend as resolveStorageBackend } from "../../engine/backend.js";
import { claimableAcrossRepos, type WorkScope } from "../../engine/workqueue.js";
import type { AskEntry, Lane } from "../../engine/types.js";
import { ALL_TOOLS, CONTRIBUTOR_TOOLS } from "../../agent/tools.js";
import { runAgent } from "../../agent/loop.js";
import { runCoordinatorSubmitChangeset, runResolveConflict, runChangesetReview, runWorkAsk } from "../../agent/scriptedWork.js";
import type { ChatBackend } from "../../agent/chatBackend.js";
import { resolveBackend, type Provider } from "../lib/resolveChatBackend.js";
import { WorkApp } from "../../tui/WorkApp.js";
import { LogBuffer } from "../../tui/LogBuffer.js";
import { enterFullscreen } from "../../tui/fullscreen.js";
import { WIDE_BANNER } from "../lib/banner.js";
import { authedCloneUrl } from "../lib/credentials.js";
import { callRemoteTool, remoteCallTool, remoteExecuteTool } from "../lib/remoteTools.js";
import { createRepoWatchStore, type RepoWatchStore } from "../lib/watchedRepos.js";
import { resolveCliBackendMode } from "../lib/backendMode.js";
import { registerRunningProcess, unregisterRunningProcess } from "../lib/processRegistry.js";


const DEFAULT_POLL_MS = 1000;
// Bounded well below "infinite" on purpose: every turn resends the
// whole growing conversation, so a long attempt gets slower, not just
// longer, the further it runs -- and in practice a real completion
// (or a legitimate "deny") has happened well under this in every
// observed run. isActuallyDone's nudging (agent/loop.ts) already ends
// a stuck attempt early in the common case; this is the hard backstop.
const DEFAULT_MAX_TURNS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bootstraps a repo's "_repo" Lane the first time any agent looks at it,
// making that agent its coordinator -- the local-clone equivalent of
// "fork and you're the coordinator of your own workspace" (see
// site/content/remote-backend/index.md's eventual Artifacts-level fork).
// Also bootstraps the Ladder's own root "_repo" Rung if this is a
// genuinely new repo with no prior `zz ladder build` run -- without
// this, the first ladder_write_rung any agent attempts fails with "repo
// root has no note yet", which previously cost several wasted
// claim/retry turns before an agent worked around it by hand.
async function ensureRepoLane(repo: ResolvedRepo, agent: string) {
  const storage = resolveStorageBackend();
  let repoLane = await storage.readLane(repo.slug, REPO_RUNG_PATH);
  if (!repoLane) {
    repoLane = await proposeLane(repo.slug, { id: REPO_RUNG_PATH, repo: repo.slug, name: repo.name, objective: `the ${repo.slug} repository`, scope: ["**"], proposedBy: agent, coordinators: [agent] });
    const review = await ask(repo.slug, repoLane.id, { kind: "review_request", from: agent });
    await answer(repo.slug, repoLane.id, review, { from: agent, action: "grant" });
  }
  const rootRung = await storage.readAnchor(repo.slug, REPO_RUNG_PATH);
  if (!rootRung) {
    const commits = await storage.listCommits(repo.slug);
    const root = commits[0];
    if (root) {
      await mergeLaneLadder(repo.slug, {
        path: REPO_RUNG_PATH,
        kind: "repo",
        summary: `${repo.name}, bootstrapped by "${agent}" via \`zz work\`.`,
        sources: [{ kind: "commit", ref: root.sha, title: root.message, author: root.author, at: root.at }],
        children: [],
      });
    }
  }
  return repoLane;
}

// The remote-mode twin of ensureRepoLane: same bootstrap, but every
// Lane/Ladder mutation goes through callRemoteTool (the real protocol
// tools, running server-side where MaintainerDO's atomic withLane
// lives) instead of the bare engine functions, which internally need
// a Backend's writeLane/withLane -- remoteBackend deliberately doesn't
// implement those (see its own header for why). The root commit's
// sha/message come from the local clone (ensureCloned already ran) --
// cheaper than inventing a remote "list commits" tool for the one
// thing that needs it, and ladder_write_rung's server-side anchoring
// for "repo"-kind rungs ignores the sha's actual value anyway (it
// re-derives the true root commit itself); this just satisfies
// validateAnchorSources' requirement that *some* real commit source
// be present.
async function ensureRepoLaneRemote(repo: ResolvedRepo, agent: string): Promise<Lane> {
  let repoLane = (await callRemoteTool(repo.slug, "lane_get", { lane_id: REPO_RUNG_PATH })) as Lane | null;
  if (!repoLane) {
    repoLane = (await callRemoteTool(repo.slug, "lane_propose", {
      id: REPO_RUNG_PATH,
      name: repo.name,
      objective: `the ${repo.slug} repository`,
      scope: ["**"],
      actor: agent,
    })) as Lane;
    const review = (await callRemoteTool(repo.slug, "ask_post", { lane_id: repoLane.id, kind: "review_request", from: agent })) as AskEntry;
    await callRemoteTool(repo.slug, "ask_answer", { lane_id: repoLane.id, ask_id: review.id, actor: agent, action: "grant" });
  }
  const rootRung = await callRemoteTool(repo.slug, "ladder_read", { path: REPO_RUNG_PATH });
  if (!rootRung) {
    // Best-effort only: ladder_write_rung needs at least Maintainer
    // server-side, but this bootstrap runs for the FIRST agent of any
    // role to touch a fresh repo, contributor included -- a
    // contributor can't write this rung, and shouldn't need to just
    // to launch. Found live: `zz work --as <contributor>` on a repo
    // whose root rung a Maintainer hadn't written yet refused to even
    // start, with no way for a contributor-scoped identity to clear
    // it. The rung itself is enrichment for the Ladder, not something
    // claim/propose/submit (a contributor's actual job) depends on --
    // skip it here rather than block the whole launch over it.
    try {
      const rootSha = execFileSync("git", ["-C", repo.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const rootMsg = execFileSync("git", ["-C", repo.repoDir, "log", "-1", "--format=%s", rootSha], { encoding: "utf8" }).trim();
      await callRemoteTool(repo.slug, "ladder_write_rung", {
        rung: {
          path: REPO_RUNG_PATH,
          kind: "repo",
          summary: `${repo.name}, bootstrapped by "${agent}" via \`zz work\` (remote).`,
          sources: [{ kind: "commit", ref: rootSha, title: rootMsg, author: agent, at: new Date().toISOString() }],
          children: [],
        },
      });
    } catch (err) {
      console.error(`(skipping the repo's root Ladder rung -- ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return repoLane;
}

// Deliberately agent- and repo-independent, byte-for-byte identical on
// every call -- verified directly against Ollama's real caching
// behavior: a shared prefix gets reused (a cache hit costs ~0.15s here
// vs ~5-6s for a cache miss on a prompt this size), but only while the
// text actually matches exactly. Baking "${agent}"/"${repo}" into this
// string, even just once near the top, broke that for every single
// call before -- two agents (or the same agent on two different
// claimed asks) never shared a prefix, so every interleaved turn paid
// full reprocessing cost. All of that now lives in the per-call user
// message instead (see runClaimedAsk below), which was always going to
// be different per call anyway.
export const SYSTEM_PROMPT = `You are an agent in the zz coordination system. Your own agent id and which repo you're working on are given in the user message below, along with the specific Ask you've been handed.

The ask you've been handed was already filtered for you: it's one you're actually permitted to act on (open to anyone, or in a Lane where you're a coordinator). Whether you may take a *further* coordinator-only action on some OTHER Lane (granting a claim, writing into its Ladder) depends on whether you appear in that Lane's \`coordinators\` -- check with lane_get if you're ever unsure; the action will simply fail otherwise.

Conventions:
- The repo's root is one long-lived Lane, id "_repo", which never completes. If your task touches a repo other than the one your current Ask lives in, and that repo has no "_repo" yet (ladder_read it to check), create it yourself: call ladder_write_rung on that repo with a single rung { path: "_repo", kind: "repo", summary, sources: [], children: [...whatever files you're adding as its first content...] } -- the same way any other rung is written, just this one bootstraps the repo. Everything else you add to that repo later can go through ladder_write_rung's normal merge behavior.
- To work on something substantial, propose your own Lane (lane_propose) with "_repo" (or whatever Lane you're inside) as origin_lane, then post child Asks into it for the sub-work, using ask_post's depends_on when one piece of work can't start until another finishes. You're that new Lane's coordinator by default.
- Decompose aggressively: whenever a task splits into pieces that don't depend on each other, post them as separate sub-Asks rather than one big one, even if you could do it all yourself in one pass. Then leave them in the queue -- don't immediately claim and work through all of them yourself. Two things make this worth doing, not just permissible: another agent polling the same repo can pick up any sub-Ask you leave open (that's the whole point of posting into a queue instead of a private to-do list), and each sub-Ask you (or someone else) later claims starts with a small, focused context instead of one agent accumulating everything about the whole task into a single, ever-growing conversation.
- Only call ladder_write_rung for a Lane whose scope actually covers the rung's path and that you coordinate. If the right place to write is a different Lane's Ladder (e.g. the repo's own), post an Ask to that Lane instead of writing directly.
- When updating a rung that already exists (ladder_read first), judge whether the change is actually material. A cosmetic change (formatting, whitespace, a rename with no behavior change) should leave the existing description essentially untouched -- do not append a note about a trivial change just because one happened.
- You're done with the Ask you were handed once everything it depends on is itself answered. Answer it last, with a short summary of what you did as payload.
- Never answer an Ask with action "complete" unless the work actually succeeded -- if ladder_write_rung errored, read the error, fix the rung, and retry rather than answering complete anyway. If you genuinely cannot complete it after a few attempts, answer with action "deny" and explain why in the payload. A false "complete" is worse than an honest "deny".
- An empty ask_query_claimable result on a Lane you created means that Lane's own sub-work is done -- it does NOT mean the top-level Ask you were handed is done. Before you stop, always check: do you have any ask you claimed earlier (including the one you were handed) that you never went back to answer? Only stop once that's answered.

Writing code: there is no write_file tool, ever. Content is always composed as data and submitted through the protocol, never written to a working-tree file as a side channel. Committing a real change and writing the Ladder are both coordinator-only actions -- if the tools for them (commit_changeset, ladder_write_rung) aren't available to you right now, that's not an oversight, it means you're acting as a contributor on this ask, not this Lane's coordinator.
- As a contributor proposing a code change: before writing new code, call ladder_search for whatever you're about to implement -- if it already exists somewhere in the ecosystem, add it as a dependency and reference it instead of reimplementing it (that's the actual point of the Ladder being cross-repo-searchable, not just generated and forgotten). Then decide the full content of every file you're adding or changing, verify it with run_in_sandbox (pass the repo you're changing with your proposed files, plus any repo it depends on with no files so it's checked out at its real current state, and a command like "node --test") -- then post an Ask (kind "submit_changeset", payload { files: [{path, content}], message, summary: "<plain-English description of what this changes, for the Ladder>" }) into the Lane whose coordinator should review it. You don't know the eventual commit sha yet, so you can't build the real Rung -- that's the coordinator's job once it's actually committed. That's the whole of your job here: search, decide, test in the sandbox, submit, and answer your own top-level Ask complete once it's posted. Do not call commit_changeset or ladder_write_rung yourself.
- As a coordinator who claims a "submit_changeset" Ask: its payload has files/message/summary someone else already tested. Review it, then call commit_changeset with that same files/message (use author_name/author_email from whoever it's attributed to, or your own agent id if unclear) to actually commit it -- its result gives you a real commitOid. Then write TWO different kinds of rung, both anchored to that commitOid -- these are not the same thing:
  1. For each changed file, a kind "file" rung at that file's own path (e.g. "index.js") -- this is the file's CURRENT, HOLISTIC state, not a changelog entry. ladder_read that path first. If it already has content, your new summary needs to describe everything the file does now (what the old summary said, plus what you just changed) -- writing a summary that only covers your latest change and silently drops what the file already did is wrong, even though ladder_write_rung will try to catch and fix this for you.
  2. One kind "changeset" rung (path "changesets/<commitOid>") describing the commit itself, with a nested "filechange" child per file describing what changed in THIS commit specifically -- this one is historical and never gets rewritten later.
  Call ladder_write_rung for both. Then answer the Ask complete. If the change looks wrong, answer "deny" with why instead of committing it.
- If one repo's change is caused by another repo's change (an actual cross-repo dependency, like a library's bug fix forcing a consumer to adapt), set the dependent Lane's origin to the upstream Lane directly: pass lane_propose's origin_lane AND origin_repo (the other repo's slug), not your own repo's _repo. This is what makes the dependency a queryable fact instead of just a coincidence in timing.`;

async function runClaimedAsk(
  resolved: ResolvedRepo,
  laneId: string,
  theAsk: AskEntry,
  agent: string,
  alreadyClaimed: boolean,
  onLog: (line: string) => void,
  maxTurns: number,
  backend: ChatBackend,
  statusRef: { current: string },
  useRemote: boolean,
  identity: { apiBase: string; token: string } | null,
  watch: RepoWatchStore,
): Promise<void> {
  const baseStatus = statusRef.current;
  const remoteCall = useRemote ? remoteCallTool : undefined;
  // "work" and "submit_changeset" are driven by code instead of the
  // generic tool-calling loop (agent/scriptedWork.ts) -- both are the
  // ask kinds where a model assembling a large nested tool-call
  // argument (a files array, a Ladder rung tree) has actually failed
  // in practice; here the model only ever produces plain text, and the
  // code drives claiming/testing/submitting/committing/Ladder-writing
  // itself, in a fixed order. Every other ask kind still goes through
  // the generic loop below.
  if (theAsk.kind === "work") {
    // runWorkAsk itself decides whether to decompose (payload.decompose
    // forces it; otherwise a cheap model judgment call) or hand off to
    // the normal contributor flow -- see its own header comment.
    await runWorkAsk({
      resolved,
      laneId,
      theAsk,
      agent,
      alreadyClaimed,
      backend,
      onLog,
      callTool: remoteCall,
      // Gates the shard flow itself (see ScriptedFlowOptions' own
      // comment) -- only present in remote mode, where there's a real
      // Worker/Artifacts/D1 to shard against.
      authedCloneUrlFor: identity ? (slug: string) => authedCloneUrl(identity.apiBase, identity.token, slug) : undefined,
      onShardReady: (repo) => watch.add(repo),
    });
    statusRef.current = baseStatus;
    return;
  }
  if (theAsk.kind === "submit_changeset") {
    // Same reason "work" passes this (above): a changeset submitted
    // from a task shard carries a baseCommit that only exists in the
    // shard's own git history, which the three-way merge below needs
    // fetched into this repo's local clone first.
    await runCoordinatorSubmitChangeset({ resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, callTool: remoteCall, authedCloneUrlFor: identity ? (slug: string) => authedCloneUrl(identity.apiBase, identity.token, slug) : undefined });
    statusRef.current = baseStatus;
    return;
  }
  if (theAsk.kind === "resolve_conflict") {
    await runResolveConflict({ resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, callTool: remoteCall });
    statusRef.current = baseStatus;
    return;
  }
  if (theAsk.kind === "changeset_review") {
    // Lets its own review-prep step clone the real task shard
    // (scriptedWork.ts's own doc comment on this) instead of silently
    // falling back to the parent repo when one exists.
    await runChangesetReview({ resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, callTool: remoteCall, authedCloneUrlFor: identity ? (slug: string) => authedCloneUrl(identity.apiBase, identity.token, slug) : undefined });
    statusRef.current = baseStatus;
    return;
  }
  // The ask only ever reached us via claimableAcrossRepos if we're
  // actually entitled to act on it -- for a coordinator-scope kind,
  // that means we ARE this Lane's coordinator. Hand over the write
  // tools only in that case; a contributor working an open-scope ask
  // never sees commit_changeset/ladder_write_rung at all.
  const isCoordinatorAsk = ASK_SCOPE[theAsk.kind] === "coordinator";
  // If a previous attempt already claimed this ask (e.g. it hit the
  // turn limit before finishing), there's an existing lease on it --
  // claiming it again would just be a second, redundant claim_request
  // for the same target. Skip straight to the work instead.
  const beginInstruction = alreadyClaimed
    ? `You already hold a claim on this ask from an earlier attempt -- no need to call ask_claim again, go straight to doing the work, then ask_answer it.`
    : `Begin by calling ask_claim on it (repo "${resolved.slug}", lane_id "${laneId}", ask_id "${theAsk.id}", actor "${agent}"), then do the work, then ask_answer it.`;
  const result = await runAgent({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: `You are agent id "${agent}". You've been handed this claimable Ask in repo "${resolved.slug}", Lane "${laneId}": id ${theAsk.id}, kind "${theAsk.kind}", payload ${JSON.stringify(theAsk.payload)}. ${beginInstruction} Act as agent "${agent}" for every claim/post/answer/write.`,
    tools: isCoordinatorAsk ? ALL_TOOLS : CONTRIBUTOR_TOOLS,
    maxTurns,
    backend,
    onLog,
    executeTool: useRemote ? remoteExecuteTool : undefined,
    onPartial: (textSoFar) => {
      // Single line, tail-truncated -- ActivityLog budgets exactly one
      // row for the status line, so showing the most recent text (not
      // the start) is what makes this feel like live typing rather
      // than a static prefix that never changes.
      const tail = textSoFar.replace(/\s+/g, " ").slice(-120);
      statusRef.current = `${baseStatus} -- says: ${tail}`;
    },
    // The real check, not "did the model stop calling tools" -- a
    // model that only describes a plan in prose and then stops has not
    // answered this ask, no matter how confident it sounds.
    isActuallyDone: async () => {
      const lane = await resolveStorageBackend().readLane(resolved.slug, laneId);
      return lane?.history.some((e) => e.type === "ANSWER" && e.ask === theAsk.id) ?? false;
    },
  });
  statusRef.current = baseStatus;
  onLog(`done with ${theAsk.id}: ${result.turns} turns, ${result.finished ? "finished on its own" : "hit the turn limit"}.`);
}

export interface WorkOptions {
  agent?: string;
  /** --as <name>: act as a managed agent instead of yourself -- "<name>" expands to "<your username>[<name>]" and its token comes from the local registry `zz agent create`/`zz agent token` populated (see lib/identity.ts). Mutually exclusive with --agent in practice (both end up setting the same acting identity); --as is the one meant for everyday use, --agent remains for the local/demo path and edge cases (acting as something not in the local registry, e.g. via ZZ_ID). */
  as?: string;
  repos?: string[];
  scope?: WorkScope;
  stdio?: boolean;
  maxTurns?: number;
  pollMs?: number;
  model?: string;
  provider?: Provider;
  /** Forces the original local/demo backend (a real local clone, state in .zz/) instead of the default: a deployed Worker's real protocol state, driven entirely over callRemoteTool. Default is remote because that's the real coordination layer this project is about; local stays fully supported for the demo/cascade-case-study path, which has no reason to involve the network at all. */
  local?: boolean;
  /** Exits once nothing is claimable, instead of idling and rechecking forever -- for a one-off/scripted run (a demo, a CI-adjacent batch job) where "work whatever's there right now, then stop" is the actual intent, not a long-lived worker. Checked only where the loop would otherwise start idling, so a batch of several claimable asks is still worked through in full before exiting on the first truly empty poll. Ignored if askId is given. */
  noWait?: boolean;
  /** Works this one specific ask (any kind/scope -- not just changeset_review the way `zz review`'s own --ask is) and exits, regardless of what else is claimable afterward. Takes precedence over --no-wait if both are somehow given. */
  askId?: string;
}

export async function work(options: WorkOptions): Promise<void> {
  const scope: WorkScope = options.scope ?? "all";
  const provider = options.provider ?? "ollama";
  const backend = resolveBackend(provider, options.model);

  // Remote is the default -- the real coordination layer this project
  // is about runs on a deployed Worker, not a local .zz/ directory.
  // --local stays fully supported for the demo/cascade-case-study
  // path, which has no reason to touch the network at all.
  const mode = await resolveCliBackendMode(options);
  const { useRemote, identity } = mode;

  // --as mints a fresh token for the session (lib/identity.ts) --
  // clean it up on every exit path: normal completion/a thrown error
  // (the try/finally below), Ctrl+C/SIGTERM in --stdio mode (no TUI,
  // so a real SIGINT reaches this handler), and the TUI's own q/
  // Ctrl+C keypress (raw mode swallows the OS-level SIGINT translation
  // for that one, so WorkApp gets this same function as an onExit
  // prop instead -- see its own call below). mode.cleanup is
  // idempotent (backendMode.ts), safe to call from both handlers.
  process.on("SIGINT", () => {
    unregisterRunningProcess();
    void mode.cleanup().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    unregisterRunningProcess();
    void mode.cleanup().then(() => process.exit(0));
  });

  // In remote mode your identity IS your resolved credential -- default
  // --agent to it rather than silently falling through to a separate
  // (and easily stale or just never-set) agent id in
  // ~/.zz/config.json. A mismatch there isn't a soft problem: the
  // server's anti-impersonation check (handleApiCallTool) rejects
  // every single tool call whose actor/from isn't the bearer token's
  // own agent id, so this used to fail closed, silently, for anyone
  // who hadn't hand-edited config.json to match their login.
  const config = readConfig({ agent: options.agent ?? identity?.username, repos: options.repos });
  const resolvedRepos = config.repos.map((slug) => resolveRepo(slug));

  for (const r of resolvedRepos) {
    if (useRemote) {
      ensureCloned(r, authedCloneUrl(identity!.apiBase, identity!.token, r.slug));
      await ensureRepoLaneRemote(r, config.agent);
    } else {
      ensureCloned(r);
      await ensureRepoLane(r, config.agent);
    }
  }

  // The set this session actually watches -- starts as the fixed list
  // above but grows as task shards get created mid-run (see
  // agent/scriptedWork.ts's runContributorWorkAsk and
  // cli/lib/watchedRepos.ts's own header); both the TUI and mainLoop's
  // own polling read from this one store, not a separate copy each.
  const watch = createRepoWatchStore(resolvedRepos);
  // Local mode only -- remote mode has the server's own /api/me/repos
  // for `zz top`'s discovery; this is the local-mode equivalent (see
  // processRegistry.ts's own header). Re-registers whenever the
  // watched set grows (a task shard) so a `zz top --local` started
  // after that still sees the full picture.
  if (!useRemote) {
    registerRunningProcess(watch.get().map((r) => r.slug));
    watch.subscribe(() => registerRunningProcess(watch.get().map((r) => r.slug)));
  }

  const logBuffer = new LogBuffer();
  const statusRef = { current: "starting..." };
  // Timestamped so a captured --stdio log is actually parsable
  // (grep/sort by time, correlate against other logs) -- the TUI's own
  // ActivityLog stays bare (it's a live, scrolling view where the
  // "when" is "now," not a stored artifact someone greps later).
  const onLog = options.stdio ? (line: string) => console.error(`${new Date().toISOString()} ${line}`) : (line: string) => logBuffer.push(line);

  if (options.stdio) {
    // Always the full-size banner, not the narrow/responsive choice
    // --version/--help make: a --stdio run is captured to a log file
    // far more often than watched live in a genuinely tiny terminal,
    // and there's no established narrow-log-header convention to fall
    // back to here the way there is for a help screen.
    console.error(WIDE_BANNER);
    console.error(`zz work: agent="${config.agent}" scope=${scope} backend=${backend.name} mode=${useRemote ? "remote" : "local"} repos=${resolvedRepos.map((r) => r.slug).join(", ")}`);
  } else {
    enterFullscreen();
    const onExit = async () => {
      unregisterRunningProcess();
      await mode.cleanup();
    };
    render(React.createElement(WorkApp, { agent: config.agent, watch, remote: useRemote, logBuffer, statusRef, onExit }));
  }

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  // Shared by both the loop and --ask below: fast-forward a remote
  // clone against another agent's since-landed commit (once per
  // claimed ask, not every idle poll), log, and actually work it.
  const workClaimed = async (resolved: ResolvedRepo, next: Awaited<ReturnType<typeof claimableAcrossRepos>>[number]): Promise<void> => {
    if (useRemote) syncClone(resolved);
    statusRef.current = `working ${next.ask.id} (${next.ask.kind}) in ${next.repo}/${next.laneId}`;
    onLog(statusRef.current);
    await runClaimedAsk(resolved, next.laneId, next.ask, config.agent, next.alreadyClaimed, onLog, maxTurns, backend, statusRef, useRemote, identity, watch);
  };

  // --ask <id>: work this one specific ask and exit, regardless of
  // scope/kind or what else is claimable afterward -- for a one-off
  // command-line step (e.g. a demo script) where there's exactly one
  // known ask to act on, the same reasoning as `zz review`'s own --ask.
  const oneOffAsk = async (): Promise<void> => {
    const watched = watch.get();
    const claimable = await claimableAcrossRepos(watched.map((r) => ({ repo: r.slug })), config.agent, scope);
    const next = claimable.find((c) => c.ask.id === options.askId);
    if (!next) {
      console.error(`no claimable ask "${options.askId}" found across ${resolvedRepos.map((r) => r.slug).join(", ")} (scope=${scope}) -- already answered, claimed by someone else, or not permitted for this identity?`);
      process.exitCode = 1;
      return;
    }
    const resolved = watched.find((r) => r.slug === next.repo)!;
    await workClaimed(resolved, next);
  };

  const mainLoop = async (): Promise<void> => {
    let lastIdleLogged: string | null = null;
    for (;;) {
      const watched = watch.get();
      const claimable = await claimableAcrossRepos(watched.map((r) => ({ repo: r.slug })), config.agent, scope);
      if (claimable.length === 0) {
        if (options.noWait) {
          onLog(`queue drained as "${config.agent}" (scope=${scope}) -- exiting (--no-wait)`);
          return;
        }
        const msg = `idling as "${config.agent}" (scope=${scope}) -- nothing claimable, rechecking every ${Math.round(pollMs / 1000)}s`;
        statusRef.current = msg;
        if (msg !== lastIdleLogged) {
          onLog(msg);
          lastIdleLogged = msg;
        }
        await sleep(pollMs);
        continue;
      }
      lastIdleLogged = null;
      const next = claimable[0];
      const resolved = watched.find((r) => r.slug === next.repo)!;
      await workClaimed(resolved, next);
    }
  };

  const loop = options.askId ? oneOffAsk : mainLoop;

  try {
    await mode.run(loop);
  } finally {
    unregisterRunningProcess();
    await mode.cleanup();
  }
  // mainLoop only ever returns via --no-wait's drained-queue exit above
  // (otherwise its `for (;;)` runs until SIGINT/SIGTERM/the TUI's own
  // quit key, all of which already process.exit() themselves); oneOffAsk
  // always returns, by design. Either way, in the TUI case ink's raw-
  // mode stdin would otherwise keep the event loop alive forever even
  // with the loop itself done, so this has to force it down explicitly
  // rather than just letting work() return.
  if (options.noWait || options.askId) process.exit(0);
}
