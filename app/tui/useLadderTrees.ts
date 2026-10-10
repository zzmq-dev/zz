// Polls each watched repo's resolved Ladder tree (engine/ladderRender.ts's
// collectLadder -- the same resolver `zz ladder dump` uses) on an
// interval, so the TUI can show whether Ladder writes are actually
// landing, not just the Lane/Ask/Answer protocol trail.
import { useEffect, useState } from "react";
import { collectLadder, type ResolvedRung } from "../engine/ladderRender.js";

export interface LadderSnapshot {
  repo: string;
  tree: ResolvedRung;
}

export function useLadderTrees(repos: { repo: string; repoDir: string; stateDir: string }[], intervalMs = 2000): LadderSnapshot[] {
  const [snapshots, setSnapshots] = useState<LadderSnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const next: LadderSnapshot[] = [];
      for (const { repo, repoDir, stateDir } of repos) {
        try {
          const { tree } = await collectLadder(repoDir, stateDir);
          next.push({ repo, tree });
        } catch {
          // repo not onboarded/bootstrapped yet -- skip rather than crash the view
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
    // repos is expected to be stable for the process's lifetime (the configured repo list)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return snapshots;
}
