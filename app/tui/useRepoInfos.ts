// Owner + creation time for each watched repo -- fetched once per repo
// (never changes once a repo exists), not polled on useLaneSnapshots'
// own interval. Feeds LiveLog's synthesized "LANE create" entry
// (types.ts's withCreateEvents); nothing else consumes this yet.
import { useEffect, useState } from "react";
import { resolveBackend } from "../engine/backend.js";
import { callRemoteTool } from "../cli/lib/remoteTools.js";
import type { RepoInfo } from "./types.js";

export function useRepoInfos(repos: string[], remote: boolean): RepoInfo[] {
  const [infos, setInfos] = useState<RepoInfo[]>([]);
  // Contents, not identity -- same reasoning as useLaneSnapshots' own reposKey.
  const reposKey = repos.join(",");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        repos.map(async (repo): Promise<RepoInfo | null> => {
          try {
            const info = remote ? ((await callRemoteTool(repo, "repo_info", {}, true)) as { owner: string; createdAt: string }) : await resolveBackend().readRepoInfo(repo);
            return { repo, owner: info.owner, createdAt: info.createdAt };
          } catch {
            return null; // not reachable/onboarded yet, or (local) no commits yet -- skip rather than crash the view
          }
        }),
      );
      if (!cancelled) setInfos(results.filter((r): r is RepoInfo => r !== null));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, reposKey]);

  return infos;
}
