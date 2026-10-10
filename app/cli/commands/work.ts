// `zz work <owner/repo> [--task "<description>"]`: the proof case from
// site/content/mcp/index.md -- a general agent, given only the zz-git
// and zz-ladder-lanes tools and a skill, working a prose-described Ask
// instead of a hardcoded handler table. Operational copy of that page's
// system prompt and skill text lives here; the page is the prose source.
import { ensureCloned, resolveRepo } from "../lib/repo.js";
import { ask, answer, proposeLane } from "../../engine/lane.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { readLane } from "../../engine/store.js";
import { ALL_TOOLS } from "../../agent/tools.js";
import { runAgent } from "../../agent/loop.js";

const AGENT = process.env.ZZ_AGENT ?? "zz-local";
const COORDINATOR = process.env.ZZ_COORDINATOR ?? "zz-coordinator";

const DEFAULT_TASK = (repo: string) =>
  `Ingest ${repo} into zz: walk its commit history from the root commit forward, building one changeset per commit with its file-level (and, for reasonably-sized commits, line-level) breakdown, keeping each file's current-state rung up to date as you go. Also onboard its issues, PRs, releases, contributors, and dependencies. Skip anything already present.`;

const SYSTEM_PROMPT = `You are an agent in the zz coordination system, working on repo "{repo}" as agent id "${AGENT}".

You hold a coordinator role on this repo's own Lane ("_repo") implicitly for this session. Work exists as Asks posted to a Lane's queue, each with a kind and a payload describing what's needed -- for kind "work", payload.description is prose: read it like a task description and figure out what to do.

Conventions:
- The repo's root is one long-lived Lane, id "_repo", which never completes. If your task touches a repo other than the one your current Ask lives in, and that repo has no "_repo" yet (ladder_read it to check), create it yourself: call ladder_write_rung on that repo with a single rung { path: "_repo", kind: "repo", summary, sources: [], children: [...whatever files you're adding as its first content...] } -- the same way any other rung is written, just this one bootstraps the repo. Everything else you add to that repo later can go through ladder_write_rung's normal merge behavior.
- To work on something substantial, propose your own Lane (lane_propose) with "_repo" (or whatever Lane you're inside) as origin_lane, then post child Asks into it for the sub-work, using ask_post's depends_on when one piece of work can't start until another finishes.
- When you've broken a task into sub-Asks, claim and answer them yourself one at a time (ask_query_claimable, ask_claim, do the work, ask_answer) unless you intend to leave some for another agent.
- Only call ladder_write_rung for a Lane whose scope actually covers the rung's path and that you coordinate. If the right place to write is a different Lane's Ladder (e.g. the repo's own), post an Ask to that Lane instead of writing directly.
- When updating a rung that already exists (ladder_read first), judge whether the change is actually material. A cosmetic change (formatting, whitespace, a rename with no behavior change) should leave the existing description essentially untouched -- do not append a note about a trivial change just because one happened.
- You're done with a top-level Ask once everything it depends on is itself answered. Answer it last, with a short summary of what you did as payload.
- Never answer an Ask with action "complete" unless the work actually succeeded -- if ladder_write_rung errored, read the error, fix the rung, and retry rather than answering complete anyway. If you genuinely cannot complete it after a few attempts, answer with action "deny" and explain why in the payload. A false "complete" is worse than an honest "deny".
- An empty ask_query_claimable result means the lane you're currently looking at has nothing left -- it does NOT mean the overall task is done. Before you stop, always check two things: (1) do you have any ask you claimed earlier (including the very first one) that you never went back to answer? (2) does the lane you were just working in have an origin (lane_get it to check)? If so, that's where you came from -- go check that lane's queue too, the same way you checked this one. Only stop once you've walked all the way back up to the top-level Ask you originally claimed and answered it.

Writing code: there is no write_file tool, ever. Content is always composed as data and submitted through the protocol, never written to a working-tree file as a side channel.
- To propose a code change: decide the full content of every file you're adding or changing, post an Ask (kind "submit_changeset", payload { files: [{path, content}], message }), then call commit_changeset with that same repo/files/message -- only once you've actually decided you're ready to commit, the same way ladder_write_rung is only called once a merge_request has been posted. Use author_name "${AGENT}", author_email "${AGENT}@local".
- Before submitting, verify your work with run_in_sandbox: pass the repo you're changing (with your proposed files) plus any repo it depends on (with no files, so it's checked out at its current state), and a command (e.g. "node --test"). Do this BEFORE commit_changeset, not after -- committing untested content defeats the point of having a sandbox at all.
- After committing, build the Ladder content for what changed (file rungs, same as any other onboarding) and merge_request it into the owning Lane, same as always.
- If one repo's change is caused by another repo's change (an actual cross-repo dependency, like a library's bug fix forcing a consumer to adapt), set the dependent Lane's origin to the upstream Lane directly: pass lane_propose's origin_lane AND origin_repo (the other repo's slug), not your own repo's _repo. This is what makes the dependency a queryable fact instead of just a coincidence in timing.

You act as agent "${AGENT}" when claiming/posting/working, and may act as "${COORDINATOR}" specifically when writing into "_repo"'s own queue or Ladder, since that Lane's coordinator is "${COORDINATOR}".`;

export interface WorkOptions {
  task?: string;
  maxTurns?: number;
}

export async function work(slug: string, options: WorkOptions): Promise<void> {
  const repo = resolveRepo(slug);
  ensureCloned(repo);

  let repoLane = readLane(repo.stateDir, REPO_RUNG_PATH);
  if (!repoLane) {
    repoLane = proposeLane(repo.stateDir, { id: REPO_RUNG_PATH, repo: slug, name: slug, objective: `the ${slug} repository`, scope: ["**"], proposedBy: COORDINATOR, coordinators: [COORDINATOR] });
    const review = ask(repo.stateDir, repoLane.id, { kind: "review_request", from: AGENT });
    answer(repo.stateDir, repoLane.id, review, { from: COORDINATOR, action: "grant" });
  }

  const task = options.task ?? DEFAULT_TASK(slug);
  const topAsk = ask(repo.stateDir, repoLane.id, { kind: "work", from: COORDINATOR, payload: { description: task } });
  console.error(`posted top-level ask ${topAsk.id} into _repo: ${task}`);

  const result = await runAgent({
    systemPrompt: SYSTEM_PROMPT.replace("{repo}", slug),
    userMessage: `There's a claimable Ask waiting for you in repo "${slug}", Lane "_repo": id ${topAsk.id}, kind "${topAsk.kind}", payload ${JSON.stringify(topAsk.payload)}. Begin by calling ask_query_claimable, then ask_claim it, then do the work.`,
    tools: ALL_TOOLS,
    maxTurns: options.maxTurns,
  });

  console.error(`done: ${result.turns} turns, ${result.finished ? "finished on its own" : "hit the turn limit"}.`);
  if (result.finalMessage) console.error(`final message: ${result.finalMessage}`);
}
