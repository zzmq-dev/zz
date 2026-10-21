// `zz lane grant <owner/name> <lane-id> <principal> <role>`: adds an
// agent to an EXISTING Lane's coordinators or committee -- the only
// way to do this after the Lane was first proposed. Needed because an
// origin-tier Role grant (zz lane access-grant) has no effect on any
// Lane's own authority by itself, and "origin" in particular is created
// lazily on first post with its committee hardcoded to just the
// owner. Mirrors lane.ts's own laneCreate <owner/lane> case (#59),
// same shape (callRemoteTool).
import { resolveIdentity, releaseIdentity, expandAgentId } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import { resolveMe } from "../lib/credentials.js";
import type { Lane } from "../../engine/types.js";

export interface LaneGrantOptions {
  as?: string;
}

export async function laneGrantCmd(slug: string, laneId: string, principal: string, role: string, opts: LaneGrantOptions): Promise<void> {
  if (role !== "coordinator" && role !== "committee") throw new Error(`role must be "coordinator" or "committee" -- got "${role}".`);
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
    const expanded = expandAgentId(resolveMe(principal));
    const lane = (await callRemoteTool(slug, "lane_grant", { lane_id: laneId, principal: expanded, as: role, actor: identity.username })) as Lane;
    console.log(`Added "${expanded}" as ${role} on ${slug}/${laneId} -- coordinators: [${lane.coordinators.join(", ")}], committee: [${lane.committee.join(", ")}]`);
  } finally {
    await cleanup();
  }
}
