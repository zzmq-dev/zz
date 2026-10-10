// Every Lane across the repos being watched, its status, and its
// coordinators -- the "overview" building block shared by `zz work` and
// `zz top`. Scrolling (up/down, Page Up/Down, Home/End) is handled by
// the parent TabView, which passes down the resulting offset -- here it
// scrolls from the top of the list, rather than following a live tail.
import React from "react";
import { Box, Text } from "ink";
import type { LaneSnapshot } from "./types.js";

const STATUS_COLOR: Record<string, string> = {
  proposed: "yellow",
  open: "yellow",
  claimed: "blue",
  active: "cyan",
  merged: "green",
  closed: "gray",
  vetoed: "red",
  stopped: "red",
};

export function LaneList({ snapshots, maxRows, scrollOffset }: { snapshots: LaneSnapshot[]; maxRows: number; scrollOffset: number }) {
  const windowSize = Math.max(1, maxRows - 1);
  const maxOffset = Math.max(0, snapshots.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const shown = snapshots.slice(offset, offset + windowSize);

  return (
    <Box flexDirection="column">
      <Text dimColor>{snapshots.length === 0 ? "no lanes yet" : `showing ${offset + 1}-${offset + shown.length} of ${snapshots.length}`}</Text>
      {shown.map(({ repo, lane }) => (
        <Box key={`${repo}/${lane.id}`}>
          <Box width={28}>
            <Text>{repo}</Text>
          </Box>
          <Box width={24}>
            <Text bold>{lane.id}</Text>
          </Box>
          <Box width={12}>
            <Text color={STATUS_COLOR[lane.status] ?? "white"}>{lane.status}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            coord: {lane.coordinators.join(", ")}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
