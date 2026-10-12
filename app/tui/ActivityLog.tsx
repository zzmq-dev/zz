// Raw agent tool-call activity (what runAgent would otherwise print via
// console.error), captured into a LogBuffer instead so it renders inside
// a TUI tab rather than scrolling over the rendered screen. Scrolling
// (up/down, Page Up/Down, Home/End) is handled by the parent TabView,
// which passes down the resulting offset -- 0 means "follow the live
// tail".
import React from "react";
import { Box, Text } from "ink";
import { CYAN, MUTED } from "./theme.js";

export function ActivityLog({ lines, status, maxRows, scrollOffset }: { lines: readonly string[]; status: string; maxRows: number; scrollOffset: number }) {
  const windowSize = Math.max(1, maxRows - 1);
  const maxOffset = Math.max(0, lines.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const end = lines.length - offset;
  const shown = lines.slice(Math.max(0, end - windowSize), end);
  return (
    <Box flexDirection="column">
      <Text bold color={CYAN} wrap="truncate-end">
        {offset > 0 ? `${status}  (${offset} line(s) back from live -- End to catch up)` : status}
      </Text>
      {shown.length === 0 ? (
        <Text color={MUTED}>(nothing yet)</Text>
      ) : (
        shown.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line}
          </Text>
        ))
      )}
    </Box>
  );
}
