// `zz ask claim <owner/repo> <ask-id>`: the human-contributor
// counterpart to agent/scriptedWork.ts's own claim step
// (runContributorWorkAsk's `ask_claim` call) -- claims an Ask by hand,
// then opens a new Lane for the work ("my workstream", in the demo's
// own words), directly in the same repo (no sharding/forking -- that's
// the remote-autonomous-agent path's own thing, not this one, since a
// human doing this by hand clones and commits straight into the repo
// they were granted access to). Prints the new Lane's id, since
// `zz repo submit` needs it next.
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { AskEntry, Lane } from "../../engine/types.js";

export interface AskClaimOptions {
  /** Which Lane the ask lives in -- defaults to "_repo", where `zz repo ask` always posts. */
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
    const laneId = opts.lane ?? "_repo";
    const lane = (await callRemoteTool(slug, "lane_get", { lane_id: laneId })) as Lane | null;
    if (!lane) throw new Error(`no such lane "${laneId}" in ${slug}`);
    const theAsk = lane.history.find((e): e is AskEntry => e.type === "ASK" && e.id === askId);
    if (!theAsk) throw new Error(`no such ask "${askId}" in ${slug}/${laneId}`);
    const description = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);

    await callRemoteTool(slug, "ask_claim", { lane_id: laneId, ask_id: askId, actor: identity.username });

    const workLane = (await callRemoteTool(slug, "lane_propose", {
      name: description.slice(0, 60),
      objective: description,
      scope: ["**"],
      actor: identity.username,
      origin_lane: laneId,
    })) as Lane;

    console.log(`Claimed ${askId} and opened Lane ${workLane.id} for it.`);
    console.log(`Next: do the work, \`git add\` it, then \`zz repo submit ${slug} ${workLane.id} ${askId}\`.`);
  } finally {
    await cleanup();
  }
}
