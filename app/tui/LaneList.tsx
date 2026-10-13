// Every Lane across the repos being watched, its status, and its
// coordinators -- the "overview" building block shared by `zz work` and
// `zz top`. Read-only by default: scrolling (up/down, Page Up/Down,
// Home/End) is handled by the parent TabView, which passes down the
// resulting offset, scrolling from the top of the list rather than
// following a live tail.
//
// Passing onSelect switches this into an interactive picker instead
// (zz top's own lanes tab, zz work --assist's own default screen):
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
import { STATUS_COLOR, MUTED, PINK, CYAN, YELLOW } from "./theme.js";

export interface LaneListExtraRow {
  repo: string;
  laneId: string;
  label: string;
  count: number;
}

export interface LaneListProps {
  snapshots: LaneSnapshot[];
  maxRows: number;
  scrollOffset: number;
  /** Provide to make the list interactive; omit for a purely read-only view (zz work's own tab, unchanged). */
  onSelect?: (repo: string, laneId: string) => void;
  /** Extra synthetic rows appended after the real lanes (AssistApp's own "unclaimed across all repos" pseudo-lane) -- selecting one calls onSelect with its own repo/laneId pair, exactly like a real lane. */
  extraRows?: LaneListExtraRow[];
}

function askCount(snapshot: LaneSnapshot): number {
  return snapshot.lane.history.filter((e) => e.type === "ASK").length;
}

export function LaneList({ snapshots, maxRows, scrollOffset, onSelect, extraRows = [] }: LaneListProps) {
  const interactive = !!onSelect;
  const [cursor, setCursor] = useState(0);
  const { isRawModeSupported } = useStdin();
  const total = snapshots.length + extraRows.length;

  useEffect(() => {
    if (cursor >= total) setCursor(Math.max(0, total - 1));
  }, [total, cursor]);

  useInput(
    (input, key) => {
      if (!interactive) return;
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(total - 1, c + 1));
      else if (key.return) {
        if (cursor < snapshots.length) {
          const target = snapshots[cursor];
          if (target) onSelect!(target.repo, target.lane.id);
        } else {
          const extra = extraRows[cursor - snapshots.length];
          if (extra) onSelect!(extra.repo, extra.laneId);
        }
      }
    },
    { isActive: isRawModeSupported },
  );

  // Interactive mode manages its own scroll window (centered on the
  // cursor), same reasoning as AssistApp's own picker: the parent's
  // scrollOffset has no way to know about a cursor it doesn't control.
  const windowSize = Math.max(1, maxRows - 1);
  const windowStart = interactive ? Math.max(0, Math.min(cursor - Math.floor(windowSize / 2), Math.max(0, total - windowSize))) : Math.min(scrollOffset, Math.max(0, total - windowSize));
  const windowEnd = Math.min(total, windowStart + windowSize);

  const rows: React.ReactElement[] = [];
  for (let idx = windowStart; idx < windowEnd; idx++) {
    const current = interactive && idx === cursor;
    if (idx < snapshots.length) {
      const { repo, lane } = snapshots[idx];
      rows.push(
        <Box key={`${repo}/${lane.id}`}>
          <Box flexShrink={0}>
            <Text color={current ? CYAN : undefined} bold={current}>
              {current ? "> " : "  "}
            </Text>
          </Box>
          <Box width={26} marginRight={1} flexShrink={0}>
            <Text color={current ? CYAN : MUTED} bold={current} wrap="truncate-end">
              {repo}
            </Text>
          </Box>
          <Box width={22} marginRight={1} flexShrink={0}>
            <Text bold color={current ? CYAN : PINK} wrap="truncate-end">
              {lane.id}
            </Text>
          </Box>
          <Box width={12} marginRight={1} flexShrink={0}>
            <Text bold color={STATUS_COLOR[lane.status] ?? MUTED} wrap="truncate-end">
              {lane.status}
            </Text>
          </Box>
          <Box width={10} marginRight={1} flexShrink={0}>
            <Text color={MUTED} wrap="truncate-end">
              {askCount(snapshots[idx])} ask{askCount(snapshots[idx]) === 1 ? "" : "s"}
            </Text>
          </Box>
          <Text color={MUTED} wrap="truncate-end">
            coord: {lane.coordinators.join(", ")}
          </Text>
        </Box>,
      );
    } else {
      const extra = extraRows[idx - snapshots.length];
      rows.push(
        <Box key={`extra:${extra.repo}/${extra.laneId}`}>
          <Box flexShrink={0}>
            <Text color={current ? CYAN : undefined} bold={current}>
              {current ? "> " : "  "}
            </Text>
          </Box>
          <Text bold={current} color={current ? CYAN : YELLOW} wrap="truncate-end">
            {extra.label}
          </Text>
          <Text color={MUTED} wrap="truncate-end">
            {" "}
            ({extra.count})
          </Text>
        </Box>,
      );
    }
  }

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>
        {total === 0 ? "no lanes yet" : `showing ${windowStart + 1}-${windowEnd} of ${total}`}
        {interactive ? "   enter: view asks in this lane" : ""}
      </Text>
      {rows}
    </Box>
  );
}
