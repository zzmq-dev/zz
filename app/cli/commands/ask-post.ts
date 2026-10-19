// `zz ask post <repo> <lane>`: lets a human post an Ask into a Lane's
// queue directly, without writing a throwaway script -- mainly for
// driving/testing `zz work`'s loop by hand (propose some work, watch an
// agent pick it up). Local-only by default (the original use case);
// --remote posts to a real hosted repo instead, via the same
// callRemoteTool path ask-claim.ts/ask-answer.ts use. The one real
// gap this used to have relative to the now-retired `zz repo ask`
// (#43) -- a brand-new repo with no origin Lane yet throwing "no such
// lane" -- is fixed at the server (worker/src/webApp.ts's
// handleApiCallTool self-heals ask_post on exactly that error), not
// here, so every caller of the generic tool gets it, not just this CLI
// command.
import { resolveRepo } from "../lib/repo.js";
import { ask } from "../../engine/lane.js";
import type { AskEntry, AskKind } from "../../engine/types.js";
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";

export interface AskPostOptions {
  kind?: string;
  from?: string;
  description?: string;
  decompose?: boolean;
  payload?: string;
  priority?: number;
  remote?: boolean;
  as?: string;
}

export async function askPost(repoSlug: string, laneId: string, options: AskPostOptions): Promise<void> {
  const kind = (options.kind ?? "work") as AskKind;
  let payload: unknown;
  if (options.payload) {
    payload = JSON.parse(options.payload);
  } else if (options.description) {
    payload = { description: options.description, ...(options.decompose ? { decompose: true } : {}) };
  }

  if (options.remote) {
    const identity = await resolveIdentity(options.as);
    setActiveToken(identity.token);
    try {
      const posted = (await callRemoteTool(repoSlug, "ask_post", { lane_id: laneId, kind, from: identity.username, payload, priority: options.priority })) as AskEntry;
      console.log(`posted ${posted.id} (kind "${kind}", from "${identity.username}") into ${repoSlug}/${laneId}`);
    } finally {
      await releaseIdentity(identity);
    }
    return;
  }

  const repo = resolveRepo(repoSlug);
  const from = options.from ?? "human";
  const posted = await ask(repo.slug, laneId, { kind, from, payload, priority: options.priority });
  console.log(`posted ${posted.id} (kind "${kind}", from "${from}") into ${repoSlug}/${laneId}`);
}
