// `zz ask list <owner/repo> [lane]`: the read counterpart to `zz ask
// post` -- shows a Lane's full history (every ASK/ANSWER/INSIGHT
// posted so far). Replaces the now-retired `zz repo asks` (#43),
// which only ever showed the origin Lane and used its own dedicated
// REST endpoint for that one case; this reads any Lane, through the
// same generic lane_get tool the rest of the CLI already uses.
import { callRemoteTool } from "../lib/remoteTools.js";
import type { Lane } from "../../engine/types.js";
import { ORIGIN_LANE_ID } from "../../engine/lane.js";

export async function askList(slug: string, laneId?: string): Promise<void> {
  const lane = (await callRemoteTool(slug, "lane_get", { lane_id: laneId ?? ORIGIN_LANE_ID })) as Lane | null;
  const history = lane?.history ?? [];
  if (history.length === 0) {
    console.log("No Asks posted yet.");
    return;
  }
  for (const e of history) {
    if (e.type === "ASK") console.log(`[ASK ${e.id}] (${e.kind}) from ${e.from} -- ${JSON.stringify(e.payload)} @ ${e.at}`);
    else if (e.type === "ANSWER") console.log(`[ANSWER ${e.id}] ${e.action} by ${e.from} on ${e.ask} @ ${e.at}`);
    else console.log(`[INSIGHT] (${e.kind}) by ${e.from} -- ${e.text} @ ${e.at}`);
  }
}
