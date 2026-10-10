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
import type { LogBuffer } from "./LogBuffer.js";

export function WorkApp({
  agent,
  repos,
  logBuffer,
  statusRef,
}: {
  agent: string;
  repos: { repo: string; repoDir: string; stateDir: string }[];
  logBuffer: LogBuffer;
  statusRef: { current: string };
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
      tabs={[
        { label: "activity", content: (maxRows, scrollOffset) => <ActivityLog lines={logBuffer.all} status={statusRef.current} maxRows={maxRows} scrollOffset={scrollOffset} /> },
        { label: "lanes", content: (maxRows, scrollOffset) => <LaneList snapshots={snapshots} maxRows={maxRows} scrollOffset={scrollOffset} /> },
        { label: "ladder", content: (maxRows, scrollOffset) => <LadderView snapshots={ladders} maxRows={maxRows} scrollOffset={scrollOffset} /> },
        { label: "protocol", content: (maxRows, scrollOffset) => <LiveLog events={flattenEvents(snapshots)} maxRows={maxRows} scrollOffset={scrollOffset} /> },
      ]}
    />
  );
}
