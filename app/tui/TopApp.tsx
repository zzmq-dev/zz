// `zz top`: the real-time dashboard. Same building blocks as `zz
// work`'s view (TabView/LaneList/LiveLog/LadderView), just without an
// activity tab since `zz top` isn't itself running an agent -- it's
// purely a watcher over whatever repos are in the local config.
import React from "react";
import { TabView } from "./TabView.js";
import { LaneList } from "./LaneList.js";
import { LiveLog } from "./LiveLog.js";
import { LadderView } from "./LadderView.js";
import { useLaneSnapshots } from "./useLaneSnapshots.js";
import { useLadderTrees } from "./useLadderTrees.js";
import { flattenEvents } from "./types.js";

export function TopApp({ repos }: { repos: { repo: string; repoDir: string; stateDir: string }[] }) {
  const snapshots = useLaneSnapshots(repos);
  const ladders = useLadderTrees(repos);
  return (
    <TabView
      title="zz top"
      tabs={[
        { label: "lanes", content: (maxRows, scrollOffset) => <LaneList snapshots={snapshots} maxRows={maxRows} scrollOffset={scrollOffset} /> },
        { label: "ladder", content: (maxRows, scrollOffset) => <LadderView snapshots={ladders} maxRows={maxRows} scrollOffset={scrollOffset} /> },
        { label: "protocol", content: (maxRows, scrollOffset) => <LiveLog events={flattenEvents(snapshots)} maxRows={maxRows} scrollOffset={scrollOffset} /> },
      ]}
    />
  );
}
