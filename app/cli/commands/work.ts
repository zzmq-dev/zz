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
import { render } from "ink";
import { ensureCloned, resolveRepo, type ResolvedRepo } from "../lib/repo.js";
import { readConfig } from "../lib/config.js";
import { ask, answer, ASK_SCOPE, mergeLaneLadder, proposeLane } from "../../engine/lane.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { readLane } from "../../engine/store.js";
import { readAnchor } from "../../engine/ladderNotes.js";
import { listCommitsChronological } from "../../engine/ingest.js";
import { claimableAcrossRepos, type WorkScope } from "../../engine/workqueue.js";
import type { AskEntry } from "../../engine/types.js";
import { ALL_TOOLS, CONTRIBUTOR_TOOLS } from "../../agent/tools.js";
import { runAgent } from "../../agent/loop.js";
import { WorkApp } from "../../tui/WorkApp.js";
import { LogBuffer } from "../../tui/LogBuffer.js";

const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_TURNS = 200; // high, not infinite -- a runaway loop should still end somewhere even with a free local model

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
  let repoLane = readLane(repo.stateDir, REPO_RUNG_PATH);
  if (!repoLane) {
    repoLane = proposeLane(repo.stateDir, { id: REPO_RUNG_PATH, repo: repo.slug, name: repo.name, objective: `the ${repo.slug} repository`, scope: ["**"], proposedBy: agent, coordinators: [agent] });
    const review = ask(repo.stateDir, repoLane.id, { kind: "review_request", from: agent });
    answer(repo.stateDir, repoLane.id, review, { from: agent, action: "grant" });
  }
  const rootRung = await readAnchor(repo.repoDir, repo.stateDir, REPO_RUNG_PATH);
  if (!rootRung) {
    const commits = listCommitsChronological(repo.repoDir);
    const root = commits[0];
    if (root) {
      await mergeLaneLadder(repo.repoDir, repo.stateDir, {
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

function systemPromptFor(agent: string, repo: string): string {
  return `You are an agent in the zz coordination system, working on repo "${repo}" as agent id "${agent}".

The ask you've been handed below was already filtered for you: it's one you're actually permitted to act on (open to anyone, or in a Lane where "${agent}" is a coordinator). Whether you may take a *further* coordinator-only action on some OTHER Lane (granting a claim, writing into its Ladder) depends on whether "${agent}" appears in that Lane's \`coordinators\` -- check with lane_get if you're ever unsure; the action will simply fail otherwise.

Conventions:
- The repo's root is one long-lived Lane, id "_repo", which never completes. If your task touches a repo other than the one your current Ask lives in, and that repo has no "_repo" yet (ladder_read it to check), create it yourself: call ladder_write_rung on that repo with a single rung { path: "_repo", kind: "repo", summary, sources: [], children: [...whatever files you're adding as its first content...] } -- the same way any other rung is written, just this one bootstraps the repo. Everything else you add to that repo later can go through ladder_write_rung's normal merge behavior.
- To work on something substantial, propose your own Lane (lane_propose) with "_repo" (or whatever Lane you're inside) as origin_lane, then post child Asks into it for the sub-work, using ask_post's depends_on when one piece of work can't start until another finishes. You're that new Lane's coordinator by default.
- Once you've broken a task into sub-Asks in your own Lane, use ask_query_claimable/ask_claim to work them yourself one at a time, unless you intend to leave some for another agent.
- Only call ladder_write_rung for a Lane whose scope actually covers the rung's path and that you coordinate. If the right place to write is a different Lane's Ladder (e.g. the repo's own), post an Ask to that Lane instead of writing directly.
- When updating a rung that already exists (ladder_read first), judge whether the change is actually material. A cosmetic change (formatting, whitespace, a rename with no behavior change) should leave the existing description essentially untouched -- do not append a note about a trivial change just because one happened.
- You're done with the Ask you were handed once everything it depends on is itself answered. Answer it last, with a short summary of what you did as payload.
- Never answer an Ask with action "complete" unless the work actually succeeded -- if ladder_write_rung errored, read the error, fix the rung, and retry rather than answering complete anyway. If you genuinely cannot complete it after a few attempts, answer with action "deny" and explain why in the payload. A false "complete" is worse than an honest "deny".
- An empty ask_query_claimable result on a Lane you created means that Lane's own sub-work is done -- it does NOT mean the top-level Ask you were handed is done. Before you stop, always check: do you have any ask you claimed earlier (including the one you were handed) that you never went back to answer? Only stop once that's answered.

Writing code: there is no write_file tool, ever. Content is always composed as data and submitted through the protocol, never written to a working-tree file as a side channel. Committing a real change and writing the Ladder are both coordinator-only actions -- if the tools for them (commit_changeset, ladder_write_rung) aren't available to you right now, that's not an oversight, it means you're acting as a contributor on this ask, not this Lane's coordinator.
- As a contributor proposing a code change: decide the full content of every file you're adding or changing, verify it with run_in_sandbox (pass the repo you're changing with your proposed files, plus any repo it depends on with no files so it's checked out at its real current state, and a command like "node --test") -- then post an Ask (kind "submit_changeset", payload { files: [{path, content}], message, summary: "<plain-English description of what this changes, for the Ladder>" }) into the Lane whose coordinator should review it. You don't know the eventual commit sha yet, so you can't build the real Rung -- that's the coordinator's job once it's actually committed. That's the whole of your job here: decide, test in the sandbox, submit, and answer your own top-level Ask complete once it's posted. Do not call commit_changeset or ladder_write_rung yourself.
- As a coordinator who claims a "submit_changeset" Ask: its payload has files/message/summary someone else already tested. Review it, then call commit_changeset with that same files/message (use author_name/author_email from whoever it's attributed to, or your own agent id if unclear) to actually commit it -- its result gives you a real commitOid. Then write TWO different kinds of rung, both anchored to that commitOid -- these are not the same thing:
  1. For each changed file, a kind "file" rung at that file's own path (e.g. "index.js") -- this is the file's CURRENT, HOLISTIC state, not a changelog entry. ladder_read that path first. If it already has content, your new summary needs to describe everything the file does now (what the old summary said, plus what you just changed) -- writing a summary that only covers your latest change and silently drops what the file already did is wrong, even though ladder_write_rung will try to catch and fix this for you.
  2. One kind "changeset" rung (path "changesets/<commitOid>") describing the commit itself, with a nested "filechange" child per file describing what changed in THIS commit specifically -- this one is historical and never gets rewritten later.
  Call ladder_write_rung for both. Then answer the Ask complete. If the change looks wrong, answer "deny" with why instead of committing it.
- If one repo's change is caused by another repo's change (an actual cross-repo dependency, like a library's bug fix forcing a consumer to adapt), set the dependent Lane's origin to the upstream Lane directly: pass lane_propose's origin_lane AND origin_repo (the other repo's slug), not your own repo's _repo. This is what makes the dependency a queryable fact instead of just a coincidence in timing.

You act as agent "${agent}" for every claim/post/answer/write below.`;
}

async function runClaimedAsk(resolved: ResolvedRepo, laneId: string, theAsk: AskEntry, agent: string, alreadyClaimed: boolean, onLog: (line: string) => void, maxTurns: number): Promise<void> {
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
    systemPrompt: systemPromptFor(agent, resolved.slug),
    userMessage: `You've been handed this claimable Ask in repo "${resolved.slug}", Lane "${laneId}": id ${theAsk.id}, kind "${theAsk.kind}", payload ${JSON.stringify(theAsk.payload)}. ${beginInstruction}`,
    tools: isCoordinatorAsk ? ALL_TOOLS : CONTRIBUTOR_TOOLS,
    maxTurns,
    onLog,
  });
  onLog(`done with ${theAsk.id}: ${result.turns} turns, ${result.finished ? "finished on its own" : "hit the turn limit"}.`);
}

export interface WorkOptions {
  agent?: string;
  repos?: string[];
  scope?: WorkScope;
  stdio?: boolean;
  maxTurns?: number;
  pollMs?: number;
}

export async function work(options: WorkOptions): Promise<void> {
  const config = readConfig({ agent: options.agent, repos: options.repos });
  const scope: WorkScope = options.scope ?? "all";
  const resolvedRepos = config.repos.map((slug) => resolveRepo(slug));
  for (const r of resolvedRepos) {
    ensureCloned(r);
    await ensureRepoLane(r, config.agent);
  }

  const logBuffer = new LogBuffer();
  const statusRef = { current: "starting..." };
  const onLog = options.stdio ? (line: string) => console.error(line) : (line: string) => logBuffer.push(line);

  if (options.stdio) {
    console.error(`zz work: agent="${config.agent}" scope=${scope} repos=${config.repos.join(", ")}`);
  } else {
    render(React.createElement(WorkApp, { agent: config.agent, repos: resolvedRepos.map((r) => ({ repo: r.slug, repoDir: r.repoDir, stateDir: r.stateDir })), logBuffer, statusRef }));
  }

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  let lastIdleLogged: string | null = null;

  for (;;) {
    const claimable = claimableAcrossRepos(resolvedRepos.map((r) => ({ repo: r.slug, stateDir: r.stateDir })), config.agent, scope);
    if (claimable.length === 0) {
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
    const resolved = resolvedRepos.find((r) => r.slug === next.repo)!;
    statusRef.current = `working ${next.ask.id} (${next.ask.kind}) in ${next.repo}/${next.laneId}`;
    onLog(statusRef.current);
    await runClaimedAsk(resolved, next.laneId, next.ask, config.agent, next.alreadyClaimed, onLog, maxTurns);
  }
}
