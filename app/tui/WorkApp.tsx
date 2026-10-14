// `zz work`'s default (non --stdio) view: live feed / lanes / ladder /
// activity, built from the same TabView/LaneList/LiveLog/LadderView used
// by `zz top`, plus a live feed tab fed by the running work loop's
// LogBuffer.
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { TabView } from "./TabView.js";
import { LaneList } from "./LaneList.js";
import { LiveLog } from "./LiveLog.js";
import { ActivityLog } from "./ActivityLog.js";
import { LadderView } from "./LadderView.js";
import { useLaneSnapshots } from "./useLaneSnapshots.js";
import { useLadderTrees } from "./useLadderTrees.js";
import { useRepoInfos } from "./useRepoInfos.js";
import { flattenEvents, withCreateEvents } from "./types.js";
import { laneListText, liveLogText, ladderText } from "./textExport.js";
import type { LogBuffer } from "./LogBuffer.js";

// Loose structural shape, not an import of cli/lib/watchedRepos.js's
// RepoWatchStore -- tui/ has never depended on cli/ (the dependency
// runs the other way, cli/commands/work.ts imports WorkApp), and a
// real ResolvedRepo[] (the store's actual get() type) is a structural
// superset of this, so it's assignable here with no import needed.
interface RepoWatch {
  get(): { slug: string; repoDir: string; stateDir: string }[];
  subscribe(listener: () => void): () => void;
}

export function WorkApp({
  agent,
  watch,
  remote,
  logBuffer,
  statusRef,
  onExit,
}: {
  agent: string;
  /** The session's live watched-repo set -- grows as `zz work` creates/discovers task shards mid-run (agent/scriptedWork.ts), not just the fixed set `zz work` started with. */
  watch: RepoWatch;
  /** Mirrors work.ts's own useRemote: in remote mode, Lane/Ladder state lives on the deployed Worker, not in a local clone's flat files/git notes, so the two view hooks need to read it over the API instead -- see useLaneSnapshots.ts/useLadderTrees.ts's own `remote` param. */
  remote: boolean;
  logBuffer: LogBuffer;
  statusRef: { current: string };
  /** Awaited before the TUI actually exits (q/Ctrl+C) -- the hook `zz work --as <name>` uses to revoke its session's token (see TabView's own comment for why this can't just be a process.on("SIGINT") handler). */
  onExit?: () => Promise<void> | void;
}) {
  const watchedRepos = useSyncExternalStore(watch.subscribe, watch.get);
  const repos = watchedRepos.map((r) => ({ repo: r.slug, repoDir: r.repoDir, stateDir: r.stateDir }));
  const snapshots = useLaneSnapshots(repos, 500, remote);
  const ladders = useLadderTrees(repos, 2000, remote);
  const repoInfos = useRepoInfos(watchedRepos.map((r) => r.slug), remote);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <TabView
      title={`zz work -- ${agent}`}
      onExit={onExit}
      tabs={[
        {
          label: "live feed",
          content: (maxRows, scrollOffset) => <ActivityLog lines={logBuffer.all} status={statusRef.current} maxRows={maxRows} scrollOffset={scrollOffset} />,
          getFullText: () => logBuffer.all.join("\n"),
        },
        { label: "lanes", content: (maxRows, scrollOffset) => <LaneList snapshots={snapshots} maxRows={maxRows} scrollOffset={scrollOffset} />, getFullText: () => laneListText(snapshots) },
        { label: "ladder", content: (maxRows, scrollOffset) => <LadderView snapshots={ladders} maxRows={maxRows} scrollOffset={scrollOffset} />, getFullText: () => ladderText(ladders) },
        {
          label: "activity",
          content: (maxRows, scrollOffset) => (
            <LiveLog events={withCreateEvents(flattenEvents(snapshots), repoInfos)} watchedRepos={watchedRepos.map((r) => r.slug)} maxRows={maxRows} scrollOffset={scrollOffset} />
          ),
          getFullText: () => liveLogText(withCreateEvents(flattenEvents(snapshots), repoInfos)),
        },
      ]}
    />
  );
}
