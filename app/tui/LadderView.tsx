// The resolved Ladder tree for ONE watched repo at a time, flattened
// into an indented list -- lets you actually see whether
// ladder_write_rung calls are landing, not just infer it from the
// protocol trail. A Ladder is inherently per-repo (unlike the Lane list
// or the protocol feed, which read fine concatenated across repos), so
// this is a switcher, not a combined view: `r` cycles which watched
// repo's tree is shown, same convention LiveLog.tsx uses for its own
// repo filter -- no key collision since TabView only ever mounts the
// active tab's component. Scrolling (up/down, Page Up/Down, Home/End)
// is handled by the parent TabView, which passes down the resulting
// offset.
import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { ResolvedRung } from "../engine/ladderRender.js";
import type { LadderSnapshot } from "./useLadderTrees.js";
import { PINK, MUTED } from "./theme.js";

interface FlatRow {
  depth: number;
  rung: ResolvedRung;
}

function flatten(rung: ResolvedRung, depth: number, out: FlatRow[]): void {
  out.push({ depth, rung });
  for (const child of rung.children) flatten(child, depth + 1, out);
}

export function LadderView({ snapshots, maxRows, scrollOffset }: { snapshots: LadderSnapshot[]; maxRows: number; scrollOffset: number }) {
  const repos = useMemo(() => Array.from(new Set(snapshots.map((s) => s.repo))), [snapshots]);
  const [selected, setSelected] = useState<string | null>(null);
  const { isRawModeSupported } = useStdin();

  useInput(
    (input) => {
      if (input !== "r" || repos.length === 0) return;
      const current = selected && repos.includes(selected) ? selected : repos[0];
      const i = repos.indexOf(current);
      setSelected(repos[(i + 1) % repos.length]);
    },
    { isActive: isRawModeSupported },
  );

  const activeRepo = selected && repos.includes(selected) ? selected : repos[0];
  const snapshot = snapshots.find((s) => s.repo === activeRepo);
  const rows: FlatRow[] = [];
  if (snapshot) flatten(snapshot.tree, 0, rows);

  const windowSize = Math.max(1, maxRows - 1);
  const maxOffset = Math.max(0, rows.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const shown = rows.slice(offset, offset + windowSize);

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>
        repo=[<Text color={repos.length > 1 ? PINK : MUTED}>{activeRepo ?? "none"}</Text>]{repos.length > 1 ? "(r)" : ""} --{" "}
        {rows.length === 0 ? "no Ladder content yet (nothing bootstrapped)" : `showing ${offset + 1}-${offset + shown.length} of ${rows.length} rungs`}
      </Text>
      {shown.map((row, i) => (
        <Box key={i}>
          <Text wrap="truncate-end">
            {"  ".repeat(row.depth)}
            <Text color={PINK}>[{row.rung.kind}]</Text> <Text bold>{row.rung.path}</Text> <Text color={MUTED}>-- {row.rung.summary}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}
