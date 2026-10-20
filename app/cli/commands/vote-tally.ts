// `zz ask vote-tally <owner/repo> <ask-id>`: counts ballots cast on a
// vote_request (zz ask answer ... vote) and, once every committee member has
// voted, closes it for real -- the human-by-hand counterpart to
// agent/tools.ts's own "vote_tally" tool. Safe to call early and
// often; it just reports who's still missing until the vote is
// actually resolved.
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { VoteTally } from "../../engine/lane.js";
import { ORIGIN_LANE_ID } from "../../engine/lane.js";

export interface VoteTallyOptions {
  lane?: string;
  as?: string;
}

export async function voteTally(slug: string, askId: string, opts: VoteTallyOptions): Promise<void> {
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
    const tally = (await callRemoteTool(slug, "vote_tally", { lane_id: laneId, ask_id: askId, actor: identity.username })) as VoteTally;
    if (!tally.resolved) {
      console.log(`Still waiting on: ${tally.missing.join(", ")}. Ballots so far: ${JSON.stringify(tally.ballots)}`);
    } else {
      console.log(`Vote closed -- ${tally.approved ? "approved" : "rejected"}. Ballots: ${JSON.stringify(tally.ballots)}`);
    }
  } finally {
    await cleanup();
  }
}
