// Every Lane across the repos being watched, its status, and its
// coordinators -- the "overview" building block shared by `zz work` and
// `zz top`. Scrolling (up/down, Page Up/Down, Home/End) is handled by
// the parent TabView, which passes down the resulting offset -- here it
// scrolls from the top of the list, rather than following a live tail.
import React from "react";
import { Box, Text } from "ink";
import type { LaneSnapshot } from "./types.js";
import { STATUS_COLOR, MUTED, PINK } from "./theme.js";

export function LaneList({ snapshots, maxRows, scrollOffset }: { snapshots: LaneSnapshot[]; maxRows: number; scrollOffset: number }) {
  const windowSize = Math.max(1, maxRows - 1);
  const maxOffset = Math.max(0, snapshots.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const shown = snapshots.slice(offset, offset + windowSize);

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>{snapshots.length === 0 ? "no lanes yet" : `showing ${offset + 1}-${offset + shown.length} of ${snapshots.length}`}</Text>
      {shown.map(({ repo, lane }) => (
        <Box key={`${repo}/${lane.id}`}>
          <Box width={28}>
            <Text color={MUTED} wrap="truncate-end">
              {repo}
            </Text>
          </Box>
          <Box width={24}>
            <Text bold color={PINK} wrap="truncate-end">
              {lane.id}
            </Text>
          </Box>
          <Box width={12}>
            <Text bold color={STATUS_COLOR[lane.status] ?? MUTED} wrap="truncate-end">
              {lane.status}
            </Text>
          </Box>
          <Text color={MUTED} wrap="truncate-end">
            coord: {lane.coordinators.join(", ")}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
