// A scrolling feed of ASK/ANSWER/INSIGHT history entries as they land,
// newest at the top, plus two synthesized "LANE" entries that aren't
// real protocol verbs (yet): a submit_changeset's actual merge moment
// (isMergeAnswer) and a repo's own creation (types.ts's
// withCreateEvents) -- both displayed as LANE events since that's
// what they'll likely become, per this feature's CHANGELOG entry.
// Has a filter bar (repo, Lane, ask kind, coordinator-vs-open role)
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

/** True for the one ANSWER that's actually the merge moment (engine/lane.ts's answer() backstop is where a submit_changeset's "complete" really runs the git merge) -- not yet a real protocol verb of its own (see this feature's CHANGELOG entry), just displayed as one. */
function isMergeAnswer(e: FlatEvent): boolean {
  return e.entry.type === "ANSWER" && e.entry.action === "complete" && e.answeredAskKind === "submit_changeset";
}

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

/** label/color (the VERB column) and kind (its own column) and extra (whatever doesn't fit the structured "[VERB] [KIND] on [REPO] [LANE] by [USER]" row -- the answered ask's id, or an Insight's actual text). */
function eventParts(e: FlatEvent): { label: string; color: string; kind: string; extra: string } {
  if (e.entry.type === "LANE") return { label: "LANE", color: PINK, kind: e.entry.kind, extra: "" };
  if (isMergeAnswer(e)) return { label: "LANE", color: PINK, kind: "merge", extra: "" };
  if (e.entry.type === "ASK") return { label: "ASK", color: YELLOW, kind: e.entry.kind, extra: "" };
  if (e.entry.type === "ANSWER") return { label: "ANSWER", color: GREEN, kind: e.entry.action, extra: `(${e.entry.ask})` };
  return { label: "NOTE", color: CYAN, kind: e.entry.kind, extra: e.entry.text };
}

function kindOf(e: FlatEvent): string | null {
  return e.entry.type === "ASK" ? e.entry.kind : null;
}

function scopeOf(e: FlatEvent): "coordinator" | "open" | "committee" | null {
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
  const [scope, setScope] = useState<"all" | "coordinator" | "open" | "committee">("all");
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
      if (input === "s") setScope((v) => (v === "all" ? "coordinator" : v === "coordinator" ? "committee" : v === "committee" ? "open" : "all"));
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
  // One row per event on a wide terminal (verb/kind/repo/lane/user all
  // fit), two on a narrower one (extra detail drops to its own line
  // below) -- see the row rendering's own comment for why.
  const windowSize = wide ? Math.max(1, maxRows - 1) : Math.max(1, Math.floor((maxRows - 1) / 2));
  const maxOffset = Math.max(0, filtered.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  // Newest first (TabView's own contract: scrollOffset 0 = latest) --
  // `filtered` itself stays chronological (flattenEvents' own sort),
  // reversed only here so this is the one feed that reads newest-at-
  // top; ActivityLog (the raw work-loop log, unaffected by any of
  // this) keeps reading top-to-bottom like a terminal.
  const reversed = useMemo(() => [...filtered].reverse(), [filtered]);
  const shown = reversed.slice(offset, offset + windowSize);

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>
        filter: repo=[<Text color={repoFilter === "all" ? MUTED : PINK}>{repoFilter}</Text>](r) lane=[<Text color={laneFilter === "all" ? MUTED : PINK}>{laneFilter}</Text>](L) kind=[
        <Text color={kindFilter === "all" ? MUTED : PINK}>{kindFilter}</Text>](t) role=[<Text color={scope === "all" ? MUTED : PINK}>{scope}</Text>](s) --{" "}
        {filtered.length === 0
          ? "no events yet"
          : `showing ${offset + 1}-${Math.min(offset + windowSize, filtered.length)} of ${filtered.length}${offset > 0 ? ` -- ${offset} back (End to catch up)` : ", live"}`}
      </Text>
      {shown.length === 0 ? (
        <Text color={MUTED}>(nothing matches)</Text>
      ) : (
        shown.map((e, i) => {
          const { label, color, kind, extra } = eventParts(e);
          const columns = (
            <>
              <Box width={12} marginRight={1} flexShrink={0}>
                <Text color={MUTED}>{shortTime(e.entry.at)}</Text>
              </Box>
              <Box width={wide ? 8 : undefined} marginRight={wide ? 1 : 0} flexShrink={0}>
                <Text bold color={color} wrap="truncate-end">
                  {label}
                </Text>
              </Box>
              <Box width={16} marginRight={1} flexShrink={0}>
                <Text wrap="truncate-end">{kind}</Text>
              </Box>
              <Box marginRight={1} flexShrink={0}>
                <Text color={MUTED}>on</Text>
              </Box>
              <Box width={22} marginRight={1} flexShrink={0}>
                <Text color={MUTED} wrap="truncate-end">
                  {e.repo}
                </Text>
              </Box>
              <Box width={14} marginRight={1} flexShrink={0}>
                <Text color={MUTED} wrap="truncate-end">
                  {e.laneId}
                </Text>
              </Box>
              <Box marginRight={1} flexShrink={0}>
                <Text color={MUTED}>by</Text>
              </Box>
              <Box flexShrink={0}>
                <Text wrap="truncate-end">{e.entry.from}</Text>
              </Box>
            </>
          );
          return wide ? (
            <Box key={i}>
              {columns}
              {extra ? <Text wrap="truncate-end"> {extra}</Text> : null}
            </Box>
          ) : (
            <Box key={i} flexDirection="column">
              <Box>{columns}</Box>
              {extra ? <Text wrap="truncate-end"> {extra}</Text> : null}
            </Box>
          );
        })
      )}
    </Box>
  );
}
