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
      const next: LaneSnapshot[] = [];
      for (const { repo, stateDir } of repos) {
        if (remote) {
          try {
            const lanes = (await callRemoteTool(repo, "lane_list", {})) as Lane[];
            for (const lane of lanes) next.push({ repo, lane });
          } catch {
            // repo not reachable/onboarded yet -- skip rather than crash the view
          }
        } else {
          for (const lane of listLanes(stateDir)) next.push({ repo, lane });
        }
      }
      if (!cancelled) setSnapshots(next);
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
