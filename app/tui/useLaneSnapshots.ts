// Polls `listLanes` across a set of repos on an interval -- the one data
// source both `zz work`'s default view and `zz top` render from. Polling
// instead of a real subscription because the underlying state is still
// flat JSON files (and later, a Backend read) -- there's nothing to
// subscribe to yet, only something to re-read.
import { useEffect, useState } from "react";
import { listLanes } from "../engine/store.js";
import type { LaneSnapshot } from "./types.js";

export function useLaneSnapshots(repos: { repo: string; stateDir: string }[], intervalMs = 500): LaneSnapshot[] {
  const [snapshots, setSnapshots] = useState<LaneSnapshot[]>([]);

  useEffect(() => {
    const read = () => {
      const next: LaneSnapshot[] = [];
      for (const { repo, stateDir } of repos) {
        for (const lane of listLanes(stateDir)) next.push({ repo, lane });
      }
      setSnapshots(next);
    };
    read();
    const id = setInterval(read, intervalMs);
    return () => clearInterval(id);
    // repos is expected to be stable for the process's lifetime (the configured repo list)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return snapshots;
}
