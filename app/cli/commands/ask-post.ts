// `zz ask post <repo> <lane>`: lets a human post an Ask into a Lane's
// queue directly, without writing a throwaway script -- mainly for
// driving/testing `zz work`'s loop by hand (propose some work, watch an
// agent pick it up). Local-only by default (the original use case);
// --remote posts to a real hosted repo instead, via the same
// callRemoteTool path ask-claim.ts/ask-answer.ts use -- needed for
// posting a kind (vote_request, whistleblow) that has no dedicated
// REST endpoint the way `zz repo ask`'s "work" posts do.
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
    payload = { description: options.description };
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
