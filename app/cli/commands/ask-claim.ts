// `zz ask claim <owner/repo> <ask-id>`: the human-contributor
// counterpart to agent/scriptedWork.ts's own claim step
// (runContributorWorkAsk's `ask_claim` call) -- claims an Ask by hand,
// then opens a new Lane for the work ("my workstream", in the demo's
// own words). Whether that Lane lives directly in the repo the Ask
// came from, or in a freshly forked task shard, is Policy's
// `claim_mode.manual` call (#37) -- a deliberate, stated choice
// instead of the old hardcoded assumption (a human by hand always
// works in_place) that this file's own comment used to bake in as if
// it were the only option. Defaults to in_place, so nothing changes
// for a repo that's never touched this setting. Prints the new Lane's
// id (and, for shard, the shard's own slug) since `zz repo submit`
// needs both next.
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { apiFetch, setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { AskEntry, Lane, RepoPolicy } from "../../engine/types.js";
import { ORIGIN_LANE_ID } from "../../engine/lane.js";

export interface AskClaimOptions {
  /** Which Lane the ask lives in -- defaults to the origin Lane, "_repo". */
  lane?: string;
  /** --as <name>: claim as a managed agent instead of yourself -- see WorkOptions.as (work.ts) / lib/identity.ts for the full resolution order. */
  as?: string;
}

export async function askClaim(slug: string, askId: string, opts: AskClaimOptions): Promise<void> {
  const identity = await resolveIdentity(opts.as);
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
    if (policy.claim_mode.manual === "shard") {
      const [owner, repoName] = slug.split("/");
      const shardRow = await apiFetch<{ slug: string }>("POST", `/api/repos/${owner}/${repoName}/shard`, { task: description });
      workRepoSlug = shardRow.slug;
    }

    const workLane = (await callRemoteTool(workRepoSlug, "lane_propose", {
      name: description.slice(0, 60),
      objective: description,
      scope: ["**"],
      actor: identity.username,
      origin_lane: laneId,
      origin_repo: slug,
    })) as Lane;

    console.log(`Claimed ${askId} and opened Lane ${workLane.id} for it${workRepoSlug !== slug ? ` in task shard ${workRepoSlug}` : ""}.`);
    console.log(`Next: do the work, \`git add\` it, then \`zz repo submit ${workRepoSlug} ${workLane.id} ${askId}\`.`);
  } finally {
    await cleanup();
  }
}
