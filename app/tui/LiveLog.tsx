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
import { useTerminalSize } from "./useTerminalSize.js";
import { YELLOW, GREEN, CYAN, MUTED, PINK } from "./theme.js";

// HH:MM:SS.mmm, local time -- a live feed is almost always read same-day,
// so the date would just be dead weight, but the milliseconds stay: this
// is meant for correlating against another timestamped source (a --stdio
// log's own `new Date().toISOString()` prefix, a screen recording's
// clock), and several events landing within the same second is common
// enough (claim+grant, or a burst of automated answers) that second-level
// precision alone would make two of them look simultaneous when they
// weren't.
function shortTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function eventParts(e: FlatEvent): { label: string; color: string; rest: string } {
  if (e.entry.type === "ASK") return { label: "ASK", color: YELLOW, rest: `${e.entry.kind} from ${e.entry.from}` };
  if (e.entry.type === "ANSWER") return { label: "ANSWER", color: GREEN, rest: `${e.entry.action} (${e.entry.ask}) from ${e.entry.from}` };
  return { label: "NOTE", color: CYAN, rest: `${e.entry.kind}: ${e.entry.text}` };
}

function kindOf(e: FlatEvent): string | null {
  return e.entry.type === "ASK" ? e.entry.kind : null;
}

function scopeOf(e: FlatEvent): "coordinator" | "open" | "maintainer" | "committee" | null {
  if (e.entry.type !== "ASK") return null;
  return ASK_SCOPE[e.entry.kind] ?? null;
}

function cycle<T>(values: T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

export function LiveLog({ events, watchedRepos = [], maxRows, scrollOffset }: { events: FlatEvent[]; /** Every repo currently being watched, not just ones with at least one event -- without this, a repo with no protocol activity yet (a brand-new Lane, or one with no Lane at all) never appeared in the "r" cycle at all, which looked indistinguishable from "doesn't know this repo exists" rather than "exists, nothing to show." */ watchedRepos?: string[]; maxRows: number; scrollOffset: number }) {
  const repos = useMemo(() => ["all", ...Array.from(new Set([...watchedRepos, ...events.map((e) => e.repo)]))], [events, watchedRepos]);
  const lanes = useMemo(() => ["all", ...Array.from(new Set(events.map((e) => e.laneId)))], [events]);
  const kinds = useMemo(() => ["all", ...Array.from(new Set(events.map(kindOf).filter((k): k is string => k !== null)))], [events]);

  const [repoFilter, setRepoFilter] = useState("all");
  const [laneFilter, setLaneFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [scope, setScope] = useState<"all" | "coordinator" | "open" | "maintainer" | "committee">("all");
  const { isRawModeSupported } = useStdin();
  // Wide enough for repo/lane/verb/detail to all fit on one line with
  // real column separation -- narrower than that, the detail line
  // drops below instead of getting squeezed into illegibility.
  const { columns } = useTerminalSize();
  const wide = columns > 80;

  useInput(
    (input) => {
      if (input === "r") setRepoFilter((v) => cycle(repos, repos.includes(v) ? v : "all"));
      if (input === "L") setLaneFilter((v) => cycle(lanes, lanes.includes(v) ? v : "all"));
      if (input === "t") setKindFilter((v) => cycle(kinds, kinds.includes(v) ? v : "all"));
      if (input === "s") setScope((v) => (v === "all" ? "coordinator" : v === "coordinator" ? "maintainer" : v === "maintainer" ? "committee" : v === "committee" ? "open" : "all"));
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
  // One row per event on a wide terminal (repo/lane/verb/detail all
  // fit), two on a narrower one (detail drops to its own line below) --
  // see the row rendering's own comment for why.
  const windowSize = wide ? Math.max(1, maxRows - 1) : Math.max(1, Math.floor((maxRows - 1) / 2));
  const maxOffset = Math.max(0, filtered.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const end = filtered.length - offset;
  const shown = filtered.slice(Math.max(0, end - windowSize), end);

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>
        filter: repo=[<Text color={repoFilter === "all" ? MUTED : PINK}>{repoFilter}</Text>](r) lane=[<Text color={laneFilter === "all" ? MUTED : PINK}>{laneFilter}</Text>](L) kind=[
        <Text color={kindFilter === "all" ? MUTED : PINK}>{kindFilter}</Text>](t) role=[<Text color={scope === "all" ? MUTED : PINK}>{scope}</Text>](s) --{" "}
        {filtered.length === 0 ? "no events yet" : `showing ${Math.max(0, end - windowSize) + 1}-${end} of ${filtered.length}${offset > 0 ? ` -- ${offset} back (End to catch up)` : ", live"}`}
      </Text>
      {shown.length === 0 ? (
        <Text color={MUTED}>(nothing matches)</Text>
      ) : (
        shown.map((e, i) => {
          const { label, color, rest } = eventParts(e);
          const columns = (
            <>
              <Box width={12} marginRight={1} flexShrink={0}>
                <Text color={MUTED}>{shortTime(e.entry.at)}</Text>
              </Box>
              <Box width={26} marginRight={1} flexShrink={0}>
                <Text color={MUTED} wrap="truncate-end">
                  {e.repo}
                </Text>
              </Box>
              <Box width={18} marginRight={1} flexShrink={0}>
                <Text color={MUTED} wrap="truncate-end">
                  {e.laneId}
                </Text>
              </Box>
              <Box width={wide ? 8 : undefined} marginRight={wide ? 1 : 0} flexShrink={0}>
                <Text bold color={color} wrap="truncate-end">
                  {label}
                </Text>
              </Box>
            </>
          );
          return wide ? (
            <Box key={i}>
              {columns}
              <Text wrap="truncate-end">{rest}</Text>
            </Box>
          ) : (
            <Box key={i} flexDirection="column">
              <Box>{columns}</Box>
              <Text wrap="truncate-end"> {rest}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
