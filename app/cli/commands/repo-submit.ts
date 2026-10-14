// `zz repo submit <owner/repo> <lane-id> <ask-id>`: the human-contributor
// counterpart to agent/scriptedWork.ts's runContributorWorkAsk -- posts
// a changeset_review + a dependent submit_changeset ask, then completes
// the work ask, exactly the same protocol sequence an LLM-driven agent
// follows via commit_changeset/ask_post/ask_answer, just reading real
// file content off disk (what you `git add`ed) instead of generating
// it. No local clone convention assumed: run this from inside whatever
// directory `zz repo clone` (or a plain `git clone` with your own
// token) put the repo in -- it operates on the current working
// directory's git index, same as any other git-adjacent CLI command.
//
// This does NOT commit anything itself -- posting a changeset_review
// only proposes one. A Maintainer still has to `zz review` and approve
// it before a coordinator's `zz work` run actually merges it (calls
// commit_changeset for real). That two-step is the point: a raw push
// bypasses per-changeset review entirely, which is exactly what this
// path exists to go through instead.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { AskEntry, Lane, RepoPolicy } from "../../engine/types.js";
import { resolvePolicyMode } from "../../engine/policy.js";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export interface RepoSubmitOptions {
  message?: string;
  /** --as <name>: submit as a managed agent instead of yourself -- see WorkOptions.as (work.ts) / lib/identity.ts for the full resolution order. */
  as?: string;
}

export async function repoSubmit(slug: string, laneId: string, askId: string, opts: RepoSubmitOptions): Promise<void> {
  const identity = await resolveIdentity(opts.as);
  setActiveToken(identity.token);

  // --as mints a fresh token for this one-shot command -- clean it up
  // however it ends, including Ctrl+C mid-flight (no TUI/raw-mode
  // here, so a real SIGINT reaches this handler).
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await releaseIdentity(identity);
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));

  try {
    // Staged-but-uncommitted is the primary case, but committing first
    // (`git add && git commit`, then this) is the more natural thing
    // for a human to actually do -- confirmed live: the demo run
    // sheet's own Stage 1 steps do exactly that, and it silently found
    // "nothing staged" before this fallback existed. Falls back to the
    // last commit's own diff against its parent, using the parent (not
    // HEAD) as baseCommit, so either workflow produces the same
    // changeset_review/submit_changeset payload.
    let changed = git(["diff", "--cached", "--name-only"])
      .split("\n")
      .filter(Boolean);
    let baseCommit: string;
    if (changed.length > 0) {
      baseCommit = git(["rev-parse", "HEAD"]);
    } else {
      let parent: string;
      try {
        parent = git(["rev-parse", "HEAD~1"]);
      } catch {
        console.error("Nothing staged, and HEAD has no parent commit to diff against. `git add` the files you changed (or commit them), then run this again.");
        process.exitCode = 1;
        return;
      }
      changed = git(["diff", "--name-only", parent, "HEAD"]).split("\n").filter(Boolean);
      if (changed.length === 0) {
        console.error("Nothing staged, and the last commit didn't change anything. `git add` the files you changed (or commit them), then run this again.");
        process.exitCode = 1;
        return;
      }
      baseCommit = parent;
    }

    const files = changed.map((path) => ({ path, content: readFileSync(path, "utf8") }));
    const message = opts.message ?? `Changes to ${changed.join(", ")}`;

    const lane = (await callRemoteTool(slug, "lane_get", { lane_id: laneId })) as Lane | null;
    if (!lane) throw new Error(`no such lane "${laneId}" in ${slug}`);
    // The ask being submitted against usually lives in laneId's own
    // origin, not laneId itself -- `zz ask claim` opens a fresh Lane
    // ("my workstream") for the work, but claiming doesn't move the
    // original ask into it. Check laneId directly first (the plain
    // case: no separate work Lane was ever opened), then its origin.
    // lane.origin.repo is the artifacts_name the server injected into
    // the lane_propose call that created this lane (repoMeta.ts's own
    // internal repo key), not the "owner/repo" slug -- compare against
    // lane.repo (the same artifacts_name, on this same Lane record),
    // not slug, or this never matches for the single-repo (no shard)
    // case repoSubmit is actually used for.
    let askLaneId = laneId;
    let theAsk = lane.history.find((e): e is AskEntry => e.type === "ASK" && e.id === askId);
    if (!theAsk && lane.origin && lane.origin.repo === lane.repo) {
      const originLane = (await callRemoteTool(slug, "lane_get", { lane_id: lane.origin.lane })) as Lane | null;
      theAsk = originLane?.history.find((e): e is AskEntry => e.type === "ASK" && e.id === askId);
      if (theAsk) askLaneId = lane.origin.lane;
    }
    if (!theAsk) throw new Error(`no such ask "${askId}" in ${slug}/${laneId}${lane.origin ? ` or its origin ${lane.origin.lane}` : ""}`);
    const taskDescription = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);

    // Not askId in depends_on when it lives in a different lane
    // (askLaneId !== laneId): depends_on resolution only ever checks
    // within the one lane an ask's own history lives in (see
    // agent/tools.ts's ask_claim, which checks `lane!.history`, never a
    // cross-lane lookup) -- a cross-lane id here could never resolve.
    // Harmless to drop: askId gets marked complete directly below
    // regardless of this dependency list.
    const dependsOn = askLaneId === laneId ? [askId] : [];
    const policy = (await callRemoteTool(slug, "policy_show", {})) as RepoPolicy;
    const rule = resolvePolicyMode(policy, changed);
    let gateDescription: string;
    if (rule.mode === "vote_quorum" || rule.mode === "vote_expiring") {
      const lazyEligible = rule.mode === "vote_expiring";
      const vote = (await callRemoteTool(slug, "ask_post", {
        lane_id: laneId,
        kind: "vote_request",
        from: identity.username,
        payload: { decisionKind: "other", taskDescription, files, message, summary: message, lazyEligible },
        depends_on: [],
        ...(lazyEligible ? { deadline: new Date(Date.now() + (rule.expiry_hours ?? 72) * 3_600_000).toISOString() } : {}),
      })) as AskEntry;
      dependsOn.push(vote.id);
      gateDescription = `a vote (vote_request ${vote.id}) -- this repo's Policy requires "${rule.mode}" for these files`;
    } else if (rule.mode !== "direct") {
      const review = (await callRemoteTool(slug, "ask_post", {
        lane_id: laneId,
        kind: "changeset_review",
        from: identity.username,
        payload: { taskDescription, files, message, summary: message },
        depends_on: [],
      })) as AskEntry;
      dependsOn.push(review.id);
      gateDescription = `review (changeset_review ${review.id})`;
    } else {
      gateDescription = `no review at all -- this repo's Policy allows a direct merge for these files`;
    }

    await callRemoteTool(slug, "ask_post", {
      lane_id: laneId,
      kind: "submit_changeset",
      from: identity.username,
      payload: { files, message, summary: message, baseCommit },
      depends_on: dependsOn,
    });

    await callRemoteTool(slug, "ask_answer", {
      lane_id: askLaneId,
      ask_id: askId,
      actor: identity.username,
      action: "complete",
      payload: { summary: message },
    });

    console.log(`Submitted ${changed.length} file(s) for ${gateDescription}, and marked ${askId} complete.`);
    console.log(
      rule.mode === "direct"
        ? `Next: a coordinator's \`zz work\` run merges it for real.`
        : rule.mode === "vote_quorum" || rule.mode === "vote_expiring"
          ? `Next: every maintainer votes (\`zz ask answer ... vote\`), then \`zz ask vote-tally\` closes it; once approved, a coordinator's \`zz work\` run merges it for real.`
          : `Next: a Maintainer needs to \`zz review\` and approve it; once granted, a coordinator's \`zz work\` run merges it for real.`,
    );
  } finally {
    await cleanup();
  }
}
