// `zz lane propose <owner/repo> <name>`: proposes a Lane by hand, the
// one way to seat an explicit multi-member Committee (--committee) --
// every other path that opens a Lane (ask-claim.ts's own claim step,
// `zz work`'s sharding) always defaults a new Lane's committee to
// just its proposer. Mirrors ask-claim.ts's shape (callRemoteTool).
import { resolveIdentity, releaseIdentity, expandAgentId } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { Lane } from "../../engine/types.js";

export interface LaneProposeOptions {
  as?: string;
  objective?: string;
  /** Comma-separated agent ids -- defaults to just you if omitted. */
  committee?: string;
  /** Explicit lane id -- omit for a generated one. */
  id?: string;
}

export async function laneProposeCmd(slug: string, name: string, opts: LaneProposeOptions): Promise<void> {
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
    const committee = opts.committee ? opts.committee.split(",").map((s) => expandAgentId(s.trim())) : undefined;
    const lane = (await callRemoteTool(slug, "lane_propose", {
      name,
      objective: opts.objective ?? name,
      scope: ["**"],
      actor: identity.username,
      id: opts.id,
      committee,
    })) as Lane;
    console.log(`Proposed Lane ${lane.id} in ${slug} -- coordinators: [${lane.coordinators.join(", ")}], committee: [${lane.committee.join(", ")}]`);
  } finally {
    await cleanup();
  }
}
