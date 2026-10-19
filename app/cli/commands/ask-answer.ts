// `zz ask answer <owner/repo> <ask-id> <action>`: the human-by-hand
// counterpart to agent/tools.ts's own "ask_answer" tool -- the one
// generic CLI path for "complete"/"deny"/"veto"/"vote", so a coordinator
// or Committee member can resolve, reject, or cast a ballot on an Ask
// without a model in the loop. Mirrors ask-claim.ts's shape exactly
// (resolveIdentity + setActiveToken + SIGINT/SIGTERM cleanup +
// callRemoteTool), since answering (like claiming) only has real
// atomicity server-side.
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { AnswerEntry } from "../../engine/types.js";
import { ORIGIN_LANE_ID } from "../../engine/lane.js";

export interface AskAnswerOptions {
  /** Which Lane the ask lives in -- defaults to "_repo", where `zz repo ask` always posts. */
  lane?: string;
  /** --as <name>: answer as a managed agent instead of yourself. */
  as?: string;
  /** Raw JSON payload -- a veto's reason, a vote's { ballot }, a complete's result, etc. */
  payload?: string;
}

export async function askAnswer(slug: string, askId: string, action: string, opts: AskAnswerOptions): Promise<void> {
  if (!["complete", "deny", "veto", "vote"].includes(action)) {
    throw new Error(`action must be one of "complete", "deny", "veto", "vote" -- got "${action}".`);
  }
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
    const payload = opts.payload ? JSON.parse(opts.payload) : undefined;
    const result = (await callRemoteTool(slug, "ask_answer", { lane_id: laneId, ask_id: askId, actor: identity.username, action, payload })) as AnswerEntry;
    console.log(`${action} ${askId} in ${slug}/${laneId} as "${identity.username}" (answer ${result.id}).`);
  } finally {
    await cleanup();
  }
}
