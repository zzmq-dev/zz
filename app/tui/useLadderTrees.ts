// Polls each watched repo's resolved Ladder tree (engine/ladderRender.ts's
// collectLadder -- the same resolver `zz ladder dump` uses) on an
// interval, so the TUI can show whether Ladder writes are actually
// landing, not just the Lane/Ask/Answer protocol trail.
import { useEffect, useState } from "react";
import { collectLadder, type ResolvedRung } from "../engine/ladderRender.js";
import { callRemoteTool } from "../cli/lib/remoteTools.js";

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
    // One round trip per repo now (ladder_tree, server-side resolved
    // and cached -- see cloudflareBackend.ts's readLadderTree), not
    // one per rung -- but still guarded against overlap, since a cold
    // cache on a large tree is still a real wait, and piling up
    // overlapping reads on top of that looks indistinguishable from
    // "never shows anything" rather than "takes a moment."
    let inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next: LadderSnapshot[] = [];
        for (const { repo, repoDir, stateDir } of repos) {
          try {
            // allowAnonymous: see useLaneSnapshots.ts's identical comment.
            const tree = remote ? ((await callRemoteTool(repo, "ladder_tree", {}, true)) as ResolvedRung | null) : (await collectLadder(repoDir, stateDir)).tree;
            if (tree) next.push({ repo, tree });
          } catch {
            // repo not onboarded/bootstrapped/reachable yet -- skip rather than crash the view
          }
        }
        if (!cancelled) setSnapshots(next);
      } finally {
        inFlight = false;
      }
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
