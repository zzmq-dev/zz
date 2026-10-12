// A scrolling feed of ASK/ANSWER/INSIGHT history entries as they land,
// with a filter bar (repo, Lane, ask kind, coordinator-vs-open role)
// cycled by key presses -- the "watch it happen live" building block, as
// opposed to reading a static dump after the fact. Scrolling itself
// (up/down, Page Up/Down, Home/End) is handled by the parent TabView,
// which passes down the resulting offset; j/k/r/L/t/s below are filter
// shortcuts, kept disjoint from TabView's own scroll/tab keys.
import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { ASK_SCOPE } from "../engine/lane.js";
import type { FlatEvent } from "./types.js";
import { YELLOW, GREEN, CYAN, MUTED, PINK } from "./theme.js";

function eventParts(e: FlatEvent): { label: string; color: string; rest: string } {
  if (e.entry.type === "ASK") return { label: "ASK", color: YELLOW, rest: `${e.entry.kind} from ${e.entry.from}` };
  if (e.entry.type === "ANSWER") return { label: "ANSWER", color: GREEN, rest: `${e.entry.action} (${e.entry.ask}) from ${e.entry.from}` };
  return { label: "NOTE", color: CYAN, rest: `${e.entry.kind}: ${e.entry.text}` };
}

function kindOf(e: FlatEvent): string | null {
  return e.entry.type === "ASK" ? e.entry.kind : null;
}

function scopeOf(e: FlatEvent): "coordinator" | "open" | "maintainer" | null {
  if (e.entry.type !== "ASK") return null;
  return ASK_SCOPE[e.entry.kind] ?? null;
}

function cycle<T>(values: T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

export function LiveLog({ events, maxRows, scrollOffset }: { events: FlatEvent[]; maxRows: number; scrollOffset: number }) {
  const repos = useMemo(() => ["all", ...Array.from(new Set(events.map((e) => e.repo)))], [events]);
  const lanes = useMemo(() => ["all", ...Array.from(new Set(events.map((e) => e.laneId)))], [events]);
  const kinds = useMemo(() => ["all", ...Array.from(new Set(events.map(kindOf).filter((k): k is string => k !== null)))], [events]);

  const [repoFilter, setRepoFilter] = useState("all");
  const [laneFilter, setLaneFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [scope, setScope] = useState<"all" | "coordinator" | "open" | "maintainer">("all");
  const { isRawModeSupported } = useStdin();

  useInput(
    (input) => {
      if (input === "r") setRepoFilter((v) => cycle(repos, repos.includes(v) ? v : "all"));
      if (input === "L") setLaneFilter((v) => cycle(lanes, lanes.includes(v) ? v : "all"));
      if (input === "t") setKindFilter((v) => cycle(kinds, kinds.includes(v) ? v : "all"));
      if (input === "s") setScope((v) => (v === "all" ? "coordinator" : v === "coordinator" ? "maintainer" : v === "maintainer" ? "open" : "all"));
    },
    { isActive: isRawModeSupported },
  );

  const filtered = events.filter((e) => {
    if (repoFilter !== "all" && e.repo !== repoFilter) return false;
    if (laneFilter !== "all" && e.laneId !== laneFilter) return false;
    if (kindFilter !== "all" && kindOf(e) !== kindFilter) return false;
    if (scope !== "all") {
      const s = scopeOf(e);
      if (s !== null && s !== scope) return false;
    }
    return true;
  });
  const windowSize = Math.max(1, maxRows - 1);
  const maxOffset = Math.max(0, filtered.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const end = filtered.length - offset;
  const shown = filtered.slice(Math.max(0, end - windowSize), end);

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>
        filter: repo=[<Text color={repoFilter === "all" ? MUTED : PINK}>{repoFilter}</Text>](r) lane=[<Text color={laneFilter === "all" ? MUTED : PINK}>{laneFilter}</Text>](L) kind=[
        <Text color={kindFilter === "all" ? MUTED : PINK}>{kindFilter}</Text>](t) role=[<Text color={scope === "all" ? MUTED : PINK}>{scope}</Text>](s) --{" "}
        {offset > 0 ? `${offset} line(s) back from live (End to catch up)` : `showing ${shown.length}/${filtered.length}, live`}
      </Text>
      {shown.length === 0 ? (
        <Text color={MUTED}>(nothing matches)</Text>
      ) : (
        shown.map((e, i) => {
          const { label, color, rest } = eventParts(e);
          return (
            <Box key={i}>
              <Box width={22}>
                <Text color={MUTED}>{e.repo}</Text>
              </Box>
              <Box width={20}>
                <Text color={MUTED}>{e.laneId}</Text>
              </Box>
              <Box width={8}>
                <Text bold color={color}>
                  {label}
                </Text>
              </Box>
              <Text wrap="truncate-end">{rest}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
