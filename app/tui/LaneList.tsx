// Every Lane across the repos being watched, its status, and its
// coordinators -- the "overview" building block shared by `zz work` and
// `zz top`. Read-only by default: scrolling (up/down, Page Up/Down,
// Home/End) is handled by the parent TabView, which passes down the
// resulting offset, scrolling from the top of the list rather than
// following a live tail.
//
// Passing onSelect switches this into an interactive picker instead
// (zz top's own lanes tab, zz work --assist's "n" from the ask picker):
// arrow keys move a selection cursor (not just scroll -- the cursor
// following its own window, same convention AssistApp's ask picker
// uses, rather than TabView's parent-driven scrollOffset, which this
// mode ignores entirely, same as Explore.tsx already does for its own
// repo list), and enter calls onSelect so the caller can push a detail
// view (LaneDetail.tsx) showing that lane's own asks -- posting a new
// ask happens there, not here, so you can see what's already queued
// before adding to it.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { LaneSnapshot } from "./types.js";
import { STATUS_COLOR, MUTED, PINK, CYAN } from "./theme.js";

export interface LaneListProps {
  snapshots: LaneSnapshot[];
  maxRows: number;
  scrollOffset: number;
  /** Provide to make the list interactive; omit for a purely read-only view (zz work's own tab, unchanged). */
  onSelect?: (repo: string, laneId: string) => void;
}

export function LaneList({ snapshots, maxRows, scrollOffset, onSelect }: LaneListProps) {
  const interactive = !!onSelect;
  const [cursor, setCursor] = useState(0);
  const { isRawModeSupported } = useStdin();

  useEffect(() => {
    if (cursor >= snapshots.length) setCursor(Math.max(0, snapshots.length - 1));
  }, [snapshots.length, cursor]);

  useInput(
    (input, key) => {
      if (!interactive) return;
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(snapshots.length - 1, c + 1));
      else if (key.return) {
        const target = snapshots[cursor];
        if (target) onSelect!(target.repo, target.lane.id);
      }
    },
    { isActive: isRawModeSupported },
  );

  // Interactive mode manages its own scroll window (centered on the
  // cursor), same reasoning as AssistApp's own picker: the parent's
  // scrollOffset has no way to know about a cursor it doesn't control.
  const windowSize = Math.max(1, maxRows - 1);
  const windowStart = interactive ? Math.max(0, Math.min(cursor - Math.floor(windowSize / 2), Math.max(0, snapshots.length - windowSize))) : Math.min(scrollOffset, Math.max(0, snapshots.length - windowSize));
  const shown = snapshots.slice(windowStart, windowStart + windowSize);

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>
        {snapshots.length === 0 ? "no lanes yet" : `showing ${windowStart + 1}-${windowStart + shown.length} of ${snapshots.length}`}
        {interactive ? "   enter: view asks in this lane" : ""}
      </Text>
      {shown.map(({ repo, lane }, i) => {
        const idx = windowStart + i;
        const current = interactive && idx === cursor;
        return (
          <Box key={`${repo}/${lane.id}`}>
            <Box flexShrink={0}>
              <Text color={current ? CYAN : undefined} bold={current}>
                {current ? "> " : "  "}
              </Text>
            </Box>
            <Box width={28} marginRight={1} flexShrink={0}>
              <Text color={current ? CYAN : MUTED} bold={current} wrap="truncate-end">
                {repo}
              </Text>
            </Box>
            <Box width={24} marginRight={1} flexShrink={0}>
              <Text bold color={current ? CYAN : PINK} wrap="truncate-end">
                {lane.id}
              </Text>
            </Box>
            <Box width={12} marginRight={1} flexShrink={0}>
              <Text bold color={STATUS_COLOR[lane.status] ?? MUTED} wrap="truncate-end">
                {lane.status}
              </Text>
            </Box>
            <Text color={MUTED} wrap="truncate-end">
              coord: {lane.coordinators.join(", ")}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
