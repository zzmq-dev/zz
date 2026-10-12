// `zz work`'s default (non --stdio) view: activity / lanes / ladder /
// protocol, built from the same TabView/LaneList/LiveLog/LadderView used
// by `zz top`, plus an activity tab fed by the running work loop's
// LogBuffer.
import React, { useEffect, useState } from "react";
import { TabView } from "./TabView.js";
import { LaneList } from "./LaneList.js";
import { LiveLog } from "./LiveLog.js";
import { ActivityLog } from "./ActivityLog.js";
import { LadderView } from "./LadderView.js";
import { useLaneSnapshots } from "./useLaneSnapshots.js";
import { useLadderTrees } from "./useLadderTrees.js";
import { flattenEvents } from "./types.js";
import { laneListText, liveLogText, ladderText } from "./textExport.js";
import type { LogBuffer } from "./LogBuffer.js";

export function WorkApp({
  agent,
  repos,
  logBuffer,
  statusRef,
  onExit,
}: {
  agent: string;
  repos: { repo: string; repoDir: string; stateDir: string }[];
  logBuffer: LogBuffer;
  statusRef: { current: string };
  /** Awaited before the TUI actually exits (q/Ctrl+C) -- the hook `zz work --as <name>` uses to revoke its session's token (see TabView's own comment for why this can't just be a process.on("SIGINT") handler). */
  onExit?: () => Promise<void> | void;
}) {
  const snapshots = useLaneSnapshots(repos);
  const ladders = useLadderTrees(repos);
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
          label: "activity",
          content: (maxRows, scrollOffset) => <ActivityLog lines={logBuffer.all} status={statusRef.current} maxRows={maxRows} scrollOffset={scrollOffset} />,
          getFullText: () => logBuffer.all.join("\n"),
        },
        { label: "lanes", content: (maxRows, scrollOffset) => <LaneList snapshots={snapshots} maxRows={maxRows} scrollOffset={scrollOffset} />, getFullText: () => laneListText(snapshots) },
        { label: "ladder", content: (maxRows, scrollOffset) => <LadderView snapshots={ladders} maxRows={maxRows} scrollOffset={scrollOffset} />, getFullText: () => ladderText(ladders) },
        {
          label: "protocol",
          content: (maxRows, scrollOffset) => <LiveLog events={flattenEvents(snapshots)} maxRows={maxRows} scrollOffset={scrollOffset} />,
          getFullText: () => liveLogText(flattenEvents(snapshots)),
        },
      ]}
    />
  );
}
