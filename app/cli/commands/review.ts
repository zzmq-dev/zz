// `zz review`: the minimal slice of what was deferred as "zz cowork"
// this session -- a human claiming and answering changeset_review asks
// specifically (the Maintainer judgment call policy requires, see
// site/content/governance/index.md), with the mechanical protocol bits
// (claim, grant/deny) handled for them rather than hand-typed. Not a
// general interactive session manager: just this one HITL-critical
// step, since that's the concrete need, not the general one.
//
// Remote by default, like `zz work` -- same reasoning: the real
// coordination layer runs on a deployed Worker, not a local .zz/
// directory, so a changeset_review posted by a remote `zz work` run
// (or the web app's own protocol activity) is invisible to this
// command unless it watches the same backend. --local keeps the
// original local/demo path fully working.
import { createInterface } from "node:readline/promises";
import { readConfig } from "../lib/config.js";
import { resolveRepo, ensureCloned, type ResolvedRepo } from "../lib/repo.js";
import { claimableAcrossRepos, type ClaimableEntry } from "../../engine/workqueue.js";
import { ask, answer } from "../../engine/lane.js";
import { resolveBackend } from "../../engine/backend.js";
import type { AskEntry } from "../../engine/types.js";
import { authedCloneUrl } from "../lib/credentials.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import { resolveCliBackendMode } from "../lib/backendMode.js";
import { registerRunningProcess, unregisterRunningProcess } from "../lib/processRegistry.js";

export interface ReviewOptions {
  agent?: string;
  /** --as <name>: act as a managed agent instead of yourself -- see WorkOptions.as (work.ts) / lib/identity.ts for the full resolution order. */
  as?: string;
  repos?: string[];
  pollMs?: number;
  local?: boolean;
  /** --ask <id>: review this one changeset_review and exit, instead of the default wait loop. For a one-off command-line step (a demo's own script, a CI-adjacent gate) where there's exactly one known ask to act on -- the loop mode is for a human sitting at a terminal, continuously reviewing whatever shows up next. Takes precedence over --no-wait if both are somehow given. */
  askId?: string;
  /** --no-wait: review everything currently claimable, one at a time same as the loop, then exit once the queue is empty -- instead of idling and rechecking forever. For draining a batch in one sitting (a demo's own script working through several asks) without knowing every ask's id up front the way --ask requires. */
  noWait?: boolean;
}

interface ChangesetReviewPayload {
  taskDescription: string;
  files: { path: string; content: string }[];
  message: string;
  summary: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printReview(resolved: ResolvedRepo, laneId: string, theAsk: AskEntry): void {
  const payload = theAsk.payload as ChangesetReviewPayload;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`changeset_review ${theAsk.id} -- ${resolved.slug}/${laneId}`);
  console.log(`${"=".repeat(72)}`);
  console.log(`Task:    ${payload.taskDescription}`);
  console.log(`Message: ${payload.message}`);
  console.log(`Summary: ${payload.summary}`);
  for (const f of payload.files) {
    console.log(`\n--- ${f.path} ---`);
    console.log(f.content);
  }
  console.log(`${"=".repeat(72)}`);
}

export async function review(options: ReviewOptions): Promise<void> {
  const mode = await resolveCliBackendMode(options);
  const { useRemote, identity } = mode;

  // --as mints a fresh token for the session -- clean it up on every
  // exit path. No TUI/raw-mode here (just readline), so an actual
  // SIGINT reaches this handler on Ctrl+C -- unlike work.ts's TUI
  // path, no separate onExit prop is needed. mode.cleanup is
  // idempotent (backendMode.ts), safe to call from both handlers.
  process.on("SIGINT", () => {
    unregisterRunningProcess();
    void mode.cleanup().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    unregisterRunningProcess();
    void mode.cleanup().then(() => process.exit(0));
  });

  // See work.ts's identical comment: in remote mode your identity IS
  // your resolved credential, not a separate (and easily mismatched)
  // id in ~/.zz/config.json -- a mismatch fails every remote call
  // closed via the server's anti-impersonation check.
  const config = readConfig({ agent: options.agent ?? identity?.username, repos: options.repos });
  const resolvedRepos = config.repos.map((slug) => resolveRepo(slug));
  // Review only ever reads a changeset's payload (already embedded in
  // the ask) and posts grant/deny -- no working tree is touched, so a
  // local clone isn't needed to review remotely. Still cloned locally
  // for the original --local/demo path, matching its previous behavior.
  if (!useRemote) {
    for (const r of resolvedRepos) ensureCloned(r);
    // Local mode only -- see processRegistry.ts's own header. No
    // shards here (review never creates work, just answers asks), so
    // a one-time registration at startup is the whole story.
    registerRunningProcess(resolvedRepos.map((r) => r.slug));
  } else {
    for (const r of resolvedRepos) ensureCloned(r, authedCloneUrl(identity!.apiBase, identity!.token, r.slug));
  }

  const pollMs = options.pollMs ?? 1000;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Shared by both modes below: print one changeset_review, prompt for
  // a verdict, claim it if needed, post the answer. "skip" means
  // "decline to act on this one" either way -- the wait loop moves on
  // to whatever's next, the one-off mode (which has nothing else to
  // move on to) just exits without having answered it.
  const reviewOne = async (next: ClaimableEntry): Promise<"approved" | "denied" | "skipped"> => {
    const resolved = resolvedRepos.find((r) => r.slug === next.repo)!;
    printReview(resolved, next.laneId, next.ask);

    const choice = (await rl.question("approve (a) / request changes (r) / skip (s)? ")).trim().toLowerCase();
    if (choice === "s") return "skipped";

    if (!next.alreadyClaimed) {
      if (useRemote) {
        await callRemoteTool(resolved.slug, "ask_claim", { lane_id: next.laneId, ask_id: next.ask.id, actor: config.agent });
      } else {
        const claim = await ask(resolved.slug, next.laneId, { kind: "claim_request", from: config.agent, payload: { target: next.ask.id } });
        const lane = await resolveBackend().readLane(resolved.slug, next.laneId);
        await answer(resolved.slug, next.laneId, claim, { from: lane?.maintainers[0] ?? config.agent, action: "grant", payload: { grant: `grant-${claim.id}` } });
      }
    }

    if (choice === "a") {
      if (useRemote) await callRemoteTool(resolved.slug, "ask_answer", { lane_id: next.laneId, ask_id: next.ask.id, actor: config.agent, action: "grant", payload: { reason: "approved by human review" } });
      else await answer(resolved.slug, next.laneId, next.ask, { from: config.agent, action: "grant", payload: { reason: "approved by human review" } });
      console.log(`approved ${next.ask.id}`);
      return "approved";
    }
    const reason = await rl.question("reason: ");
    if (useRemote) await callRemoteTool(resolved.slug, "ask_answer", { lane_id: next.laneId, ask_id: next.ask.id, actor: config.agent, action: "deny", payload: { reason } });
    else await answer(resolved.slug, next.laneId, next.ask, { from: config.agent, action: "deny", payload: { reason } });
    console.log(`requested changes on ${next.ask.id}: ${reason}`);
    return "denied";
  };

  const claimableChangesetReviews = async () =>
    (
      await claimableAcrossRepos(
        resolvedRepos.map((r) => ({ repo: r.slug })),
        config.agent,
      )
    ).filter((c) => c.ask.kind === "changeset_review");

  // --ask <id>: do that one review and exit, instead of the wait loop
  // below -- the one-off command-line step this option exists for
  // (e.g. a demo's own script) has exactly one known ask to act on and
  // nothing to wait for afterward.
  const oneOff = async (): Promise<void> => {
    const next = (await claimableChangesetReviews()).find((c) => c.ask.id === options.askId);
    if (!next) {
      console.error(`no open changeset_review ask "${options.askId}" found across ${resolvedRepos.map((r) => r.slug).join(", ")} -- already answered, claimed by someone else, or not a changeset_review?`);
      process.exitCode = 1;
      return;
    }
    await reviewOne(next);
  };

  // --no-wait: work through everything currently claimable, same one-
  // at-a-time prompt as the wait loop below, then exit on the first
  // empty poll instead of idling and rechecking forever -- for draining
  // a whole batch in one sitting without knowing every ask's id the
  // way --ask requires.
  const drainLoop = async (): Promise<void> => {
    for (;;) {
      const claimable = await claimableChangesetReviews();
      if (claimable.length === 0) return;
      await reviewOne(claimable[0]);
    }
  };

  const mainLoop = async (): Promise<void> => {
    console.log(`zz review: agent="${config.agent}" mode=${useRemote ? "remote" : "local"} repos=${resolvedRepos.map((r) => r.slug).join(", ")} -- watching for changeset_review asks you can approve`);
    for (;;) {
      const claimable = await claimableChangesetReviews();
      if (claimable.length === 0) {
        await sleep(pollMs);
        continue;
      }
      await reviewOne(claimable[0]);
    }
  };

  const loop = options.askId ? oneOff : options.noWait ? drainLoop : mainLoop;

  try {
    await mode.run(loop);
  } finally {
    rl.close();
    unregisterRunningProcess();
    await mode.cleanup();
  }
}
