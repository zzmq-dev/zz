// Shared data shapes fed into app/tui/'s components by both `zz work`
// and `zz top` -- different arrangements of the same two building
// blocks (a lane list, a filtered scrolling history feed), not two
// separate UIs with their own data model.
import type { AskEntry, HistoryEntry, Lane } from "../engine/types.js";
import { ORIGIN_LANE_ID } from "../engine/lane.js";

export interface LaneSnapshot {
  repo: string;
  lane: Lane;
}

/**
 * Not a real protocol verb -- repo creation (and later, maybe deletion)
 * isn't a Lane/Ask/Answer event anywhere in engine/types.ts, so this
 * stays a TUI-only shape, never passed to a Backend or posted anywhere.
 * Synthesized purely for display (withCreateEvents below), the same
 * way LiveLog.tsx's own isMergeAnswer relabels a real ANSWER as "LANE
 * merge" without engine/types.ts ever growing a "merge" verb either.
 */
export interface SyntheticLaneEntry {
  type: "LANE";
  kind: "create";
  from: string;
  at: string;
}

export interface FlatEvent {
  repo: string;
  laneId: string;
  entry: HistoryEntry | SyntheticLaneEntry;
  /** For an ANSWER: the kind of the ASK it answers (same lane's history, looked up once here rather than re-walked at render time) -- lets the UI special-case e.g. a submit_changeset's "complete" as a merge, without flattening losing the cross-reference. Undefined for an ASK/INSIGHT/LANE, or an ANSWER whose own ASK fell outside this snapshot's history. */
  answeredAskKind?: AskEntry["kind"];
}

export function flattenEvents(snapshots: LaneSnapshot[]): FlatEvent[] {
  const out: FlatEvent[] = [];
  for (const { repo, lane } of snapshots) {
    for (const entry of lane.history) {
      const answeredAskKind = entry.type === "ANSWER" ? lane.history.find((e): e is AskEntry => e.type === "ASK" && e.id === entry.ask)?.kind : undefined;
      out.push({ repo, laneId: lane.id, entry, answeredAskKind });
    }
  }
  out.sort((a, b) => a.entry.at.localeCompare(b.entry.at));
  return out;
}

export interface RepoInfo {
  repo: string;
  owner: string;
  createdAt: string;
}

/** Merges one synthetic "LANE create" entry per known repo into an already-flattened event list, re-sorted so it lands in its true chronological place rather than always floating to one end. */
export function withCreateEvents(events: FlatEvent[], repoInfos: RepoInfo[]): FlatEvent[] {
  if (repoInfos.length === 0) return events;
  const synthetic: FlatEvent[] = repoInfos.map((r) => ({
    repo: r.repo,
    laneId: ORIGIN_LANE_ID,
    entry: { type: "LANE", kind: "create", from: r.owner, at: r.createdAt },
  }));
  return [...events, ...synthetic].sort((a, b) => a.entry.at.localeCompare(b.entry.at));
}
