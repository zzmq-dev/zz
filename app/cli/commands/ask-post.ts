// `zz ask post <repo> <lane>`: lets a human post an Ask into a Lane's
// queue directly, without writing a throwaway script -- mainly for
// driving/testing `zz work`'s loop by hand (propose some work, watch an
// agent pick it up).
import { resolveRepo } from "../lib/repo.js";
import { ask } from "../../engine/lane.js";
import type { AskKind } from "../../engine/types.js";

export interface AskPostOptions {
  kind?: string;
  from?: string;
  description?: string;
  payload?: string;
  priority?: number;
}

export async function askPost(repoSlug: string, laneId: string, options: AskPostOptions): Promise<void> {
  const repo = resolveRepo(repoSlug);
  const kind = (options.kind ?? "work") as AskKind;
  const from = options.from ?? "human";
  let payload: unknown;
  if (options.payload) {
    payload = JSON.parse(options.payload);
  } else if (options.description) {
    payload = { description: options.description };
  }
  const posted = await ask(repo.slug, laneId, { kind, from, payload, priority: options.priority });
  console.log(`posted ${posted.id} (kind "${kind}", from "${from}") into ${repoSlug}/${laneId}`);
}
