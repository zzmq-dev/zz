// The resolved Ladder tree for each watched repo, flattened into an
// indented list -- lets you actually see whether ladder_write_rung
// calls are landing, not just infer it from the protocol trail.
// Scrolling (up/down, Page Up/Down, Home/End) is handled by the parent
// TabView, which passes down the resulting offset.
import React from "react";
import { Box, Text } from "ink";
import type { ResolvedRung } from "../engine/ladderRender.js";
import type { LadderSnapshot } from "./useLadderTrees.js";

interface FlatRow {
  repo: string;
  depth: number;
  rung: ResolvedRung;
}

function flatten(repo: string, rung: ResolvedRung, depth: number, out: FlatRow[]): void {
  out.push({ repo, depth, rung });
  for (const child of rung.children) flatten(repo, child, depth + 1, out);
}

export function LadderView({ snapshots, maxRows, scrollOffset }: { snapshots: LadderSnapshot[]; maxRows: number; scrollOffset: number }) {
  const rows: FlatRow[] = [];
  for (const { repo, tree } of snapshots) flatten(repo, tree, 0, rows);

  const windowSize = Math.max(1, maxRows - 1);
  const maxOffset = Math.max(0, rows.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const shown = rows.slice(offset, offset + windowSize);
  const multiRepo = new Set(snapshots.map((s) => s.repo)).size > 1;

  return (
    <Box flexDirection="column">
      <Text dimColor>{rows.length === 0 ? "no Ladder content yet (nothing bootstrapped)" : `showing ${offset + 1}-${offset + shown.length} of ${rows.length} rungs`}</Text>
      {shown.map((row, i) => (
        <Box key={i}>
          <Text wrap="truncate-end">
            {multiRepo ? `[${row.repo}] ` : ""}
            {"  ".repeat(row.depth)}
            <Text color="cyan">[{row.rung.kind}]</Text> <Text bold>{row.rung.path}</Text> -- {row.rung.summary}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
