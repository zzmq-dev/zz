// `zz lane propose <owner/repo> <name>`: proposes a Lane by hand, the
// one way to seat an explicit multi-member Committee (--maintainers) --
// every other path that opens a Lane (ask-claim.ts's own claim step,
// `zz work`'s sharding) always defaults a new Lane's maintainers to
// just its proposer. Mirrors ask-claim.ts's shape (callRemoteTool).
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import { requireCredentials } from "../lib/credentials.js";
import type { Lane } from "../../engine/types.js";

// Same bare-name expansion identity.ts's own resolveIdentity() does for
// --as ("alice" -> "<you>[alice]") -- applied here too so --maintainers
// can be given as plain names instead of requiring the full
// "<you>[name]" form spelled out for each one.
function expandAgentId(raw: string, humanUsername: string): string {
  return /[@[]/.test(raw) ? raw : `${humanUsername}[${raw}]`;
}

export interface LaneProposeOptions {
  as?: string;
  objective?: string;
  /** Comma-separated agent ids -- defaults to just you if omitted. */
  maintainers?: string;
  /** Explicit lane id -- omit for a generated one. */
  id?: string;
}

export async function laneProposeCmd(slug: string, name: string, opts: LaneProposeOptions): Promise<void> {
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
    const humanUsername = requireCredentials().username;
    const maintainers = opts.maintainers ? opts.maintainers.split(",").map((s) => expandAgentId(s.trim(), humanUsername)) : undefined;
    const lane = (await callRemoteTool(slug, "lane_propose", {
      name,
      objective: opts.objective ?? name,
      scope: ["**"],
      actor: identity.username,
      id: opts.id,
      maintainers,
    })) as Lane;
    console.log(`Proposed Lane ${lane.id} in ${slug} -- coordinators: [${lane.coordinators.join(", ")}], maintainers: [${lane.maintainers.join(", ")}]`);
  } finally {
    await cleanup();
  }
}
