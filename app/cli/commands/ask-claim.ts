// `zz ask claim <owner/name> <ask-id>`: the human-contributor
// counterpart to agent/scriptedWork.ts's own claim step
// (runContributorWorkAsk's `ask_claim` call) -- claims an Ask by hand,
// then opens a new Lane for the work ("my workstream", in the demo's
// own words). Whether that Lane lives directly in the repo the Ask
// came from, or gets its own independent one, is Policy's
// `claim_mode.manual` call (#37) -- a deliberate, stated choice
// instead of the old hardcoded assumption (a human by hand always
// works in_place) that this file's own comment used to bake in as if
// it were the only option. Defaults to in_place, so nothing changes
// for a repo that's never touched this setting. Prints the new Lane's
// id (and, when it got its own independent repo, that repo's own
// slug) since `zz lane submit` needs both next.
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { apiFetch, setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { AskEntry, Lane, RepoPolicy } from "../../engine/types.js";
import { ORIGIN_LANE_ID } from "../../engine/lane.js";

interface RepoRow {
  artifacts_name: string;
}

export interface AskClaimOptions {
  /** Which Lane the ask lives in -- defaults to the origin Lane, "origin". */
  lane?: string;
  /** --as <name>: claim as a managed agent instead of yourself -- see WorkOptions.as (work.ts) / lib/identity.ts for the full resolution order. */
  as?: string;
}

export async function askClaim(slug: string, askId: string, opts: AskClaimOptions): Promise<void> {
  const identity = await resolveIdentity({ as: opts.as });
  setActiveToken(identity.token);

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await releaseIdentity(identity);
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));

  try {
    const laneId = opts.lane ?? ORIGIN_LANE_ID;
    const lane = (await callRemoteTool(slug, "lane_get", { lane_id: laneId })) as Lane | null;
    if (!lane) throw new Error(`no such lane "${laneId}" in ${slug}`);
    const theAsk = lane.history.find((e): e is AskEntry => e.type === "ASK" && e.id === askId);
    if (!theAsk) throw new Error(`no such ask "${askId}" in ${slug}/${laneId}`);
    const description = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);

    await callRemoteTool(slug, "ask_claim", { lane_id: laneId, ask_id: askId, actor: identity.username });

    const policy = (await callRemoteTool(slug, "policy_show", {})) as RepoPolicy;
    let workRepoSlug = slug;
    // A real, pre-existing bug found while verifying #43's lane submit
    // lookup: origin_repo needs the ORIGINAL repo's artifacts_name (the
    // same representation lane.repo itself is always stored in, not
    // the owner/name slug) -- lane_propose stores whatever's given here
    // as-is, uninterpreted. Passing the slug directly made
    // lane.origin.repo === lane.repo (lane-submit.ts's own origin
    // fallback check) never match for an in_place claim, confirmed
    // live ("no such ask ... or its origin origin" even though the ask
    // really was in the origin Lane). Only needed when workRepoSlug
    // differs from slug (the shard case) -- lane_propose's own default
    // (falling back to the server-injected repo, which already equals
    // workRepoSlug's own artifacts_name) is already correct otherwise,
    // so this skips a needless lookup in the common, non-shard case.
    let originRepoArtifactsName: string | undefined;
    if (policy.claim_mode.manual === "shard") {
      const [owner, repoName] = slug.split("/");
      const { repo: origRepo } = await apiFetch<{ repo: RepoRow }>("GET", `/api/repos/${owner}/${repoName}`);
      originRepoArtifactsName = origRepo.artifacts_name;
      const shardRow = await apiFetch<{ slug: string }>("POST", `/api/repos/${owner}/${repoName}/shard`, { task: description });
      workRepoSlug = shardRow.slug;
    }

    const workLane = (await callRemoteTool(workRepoSlug, "lane_propose", {
      name: description.slice(0, 60),
      objective: description,
      scope: ["**"],
      actor: identity.username,
      origin_lane: laneId,
      origin_repo: originRepoArtifactsName,
    })) as Lane;

    console.log(`Claimed ${askId} and opened Lane ${workLane.id} for it${workRepoSlug !== slug ? ` in task shard ${workRepoSlug}` : ""}.`);
    console.log(`Next: do the work, \`git add\` it, then \`zz lane submit ${workRepoSlug} ${workLane.id} ${askId}\`.`);
  } finally {
    await cleanup();
  }
}
