// `zz ask whistleblow <owner/repo> <ask-id> --target-agent <id> --reason <text> [--target-commit <sha>]`:
// closes a "whistleblow" Ask (posted via `zz ask post --kind whistleblow`)
// and runs the incident runbook -- STOP this Lane, DROP the reported
// Agent's other pending Asks in it, and (if --target-commit names an
// already-merged commit) ROLL it back with a real revert commit. Only
// this Lane's coordinator can do this; the human-by-hand counterpart
// to agent/tools.ts's own "whistleblow_resolve" tool.
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import { requireCredentials } from "../lib/credentials.js";
import type { IncidentResult } from "../../engine/lane.js";
import { ORIGIN_LANE_ID } from "../../engine/lane.js";

// Same bare-name expansion as lane-propose.ts's --committee.
function expandAgentId(raw: string, humanUsername: string): string {
  return /[@[]/.test(raw) ? raw : `${humanUsername}[${raw}]`;
}

export interface WhistleblowOptions {
  lane?: string;
  as?: string;
  targetAgent: string;
  targetCommit?: string;
  reason: string;
}

export async function whistleblowResolve(slug: string, askId: string, opts: WhistleblowOptions): Promise<void> {
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
    const targetAgent = expandAgentId(opts.targetAgent, requireCredentials().username);
    const result = (await callRemoteTool(slug, "whistleblow_resolve", {
      lane_id: laneId,
      ask_id: askId,
      actor: identity.username,
      target_agent: targetAgent,
      target_commit: opts.targetCommit,
      reason: opts.reason,
    })) as IncidentResult;
    console.log(`STOP: Lane ${laneId} in ${slug} is now "stopped".`);
    console.log(`DROP: denied ${result.dropped.length} other pending ask(s) from "${targetAgent}" (${result.dropped.join(", ") || "none"}).`);
    console.log(result.rolled ? `ROLL: reverted ${result.rolled.commit} as ${result.rolled.revertCommit}.` : "ROLL: no --target-commit given, nothing reverted.");
  } finally {
    await cleanup();
  }
}
