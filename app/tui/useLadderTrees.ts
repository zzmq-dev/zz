// Polls each watched repo's resolved Ladder tree (engine/ladderRender.ts's
// collectLadder -- the same resolver `zz ladder dump` uses) on an
// interval, so the TUI can show whether Ladder writes are actually
// landing, not just the Lane/Ask/Answer protocol trail.
import { useEffect, useState } from "react";
import { collectLadder, resolveLadderTree, type ResolvedRung } from "../engine/ladderRender.js";
import { callRemoteTool } from "../cli/lib/remoteTools.js";
import type { EmbeddedRung } from "../engine/ladderNotes.js";

export interface LadderSnapshot {
  repo: string;
  tree: ResolvedRung;
}

export function useLadderTrees(repos: { repo: string; repoDir: string; stateDir: string }[], intervalMs = 2000, remote = false): LadderSnapshot[] {
  const [snapshots, setSnapshots] = useState<LadderSnapshot[]>([]);
  // See useLaneSnapshots.ts's identical comment -- content-keyed, not
  // identity-keyed, so a fresh array reference from the watch store on
  // every render doesn't restart polling unless the repo set actually changed.
  const reposKey = repos.map((r) => r.repo).join(",");

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const next: LadderSnapshot[] = [];
      for (const { repo, repoDir, stateDir } of repos) {
        try {
          const { tree } = remote ? await resolveLadderTree((path) => callRemoteTool(repo, "ladder_read", { path }) as Promise<EmbeddedRung | null>) : await collectLadder(repoDir, stateDir);
          next.push({ repo, tree });
        } catch {
          // repo not onboarded/bootstrapped/reachable yet -- skip rather than crash the view
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
