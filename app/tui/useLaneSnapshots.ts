// Polls `listLanes` across a set of repos on an interval -- the one data
// source both `zz work`'s default view and `zz top` render from. Polling
// instead of a real subscription because the underlying state is still
// flat JSON files (and later, a Backend read) -- there's nothing to
// subscribe to yet, only something to re-read.
import { useEffect, useState } from "react";
import { listLanes } from "../engine/store.js";
import { callRemoteTool } from "../cli/lib/remoteTools.js";
import type { Lane } from "../engine/types.js";
import type { LaneSnapshot } from "./types.js";

export function useLaneSnapshots(repos: { repo: string; stateDir: string }[], intervalMs = 500, remote = false): LaneSnapshot[] {
  const [snapshots, setSnapshots] = useState<LaneSnapshot[]>([]);
  // repos' CONTENTS, not its identity -- a growing watch store (see
  // cli/lib/watchedRepos.ts) gives WorkApp a fresh array reference every
  // render regardless of whether the set actually changed, so keying off
  // the array itself would restart polling every 500ms for no reason.
  const reposKey = repos.map((r) => r.repo).join(",");

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      // Parallel across repos, not sequential -- in remote mode each
      // one is its own HTTP round trip (callRemoteTool), and nothing
      // here depends on another repo's result. Watching more than one
      // repo used to pay those round trips one after another, which is
      // the real reason this ever felt slow to load.
      const perRepo = await Promise.all(
        repos.map(async ({ repo, stateDir }): Promise<LaneSnapshot[]> => {
          if (remote) {
            try {
              // allowAnonymous: zz top's "not logged in" mode (Explore's
              // whole point) still needs to watch a public repo it just
              // tracked -- the server already allows this tool with no
              // auth for a public repo (webApp.ts's ANON_READ_TOOLS).
              const lanes = (await callRemoteTool(repo, "lane_list", {}, true)) as Lane[];
              return lanes.map((lane) => ({ repo, lane }));
            } catch {
              return []; // repo not reachable/onboarded yet -- skip rather than crash the view
            }
          }
          return listLanes(stateDir).map((lane) => ({ repo, lane }));
        }),
      );
      if (!cancelled) setSnapshots(perRepo.flat());
    };
    read();
    const id = setInterval(read, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, remote, reposKey]);

  return snapshots;
}
