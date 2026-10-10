// Shared data shapes fed into app/tui/'s components by both `zz work`
// and `zz top` -- different arrangements of the same two building
// blocks (a lane list, a filtered scrolling history feed), not two
// separate UIs with their own data model.
import type { HistoryEntry, Lane } from "../engine/types.js";

export interface LaneSnapshot {
  repo: string;
  lane: Lane;
}

export interface FlatEvent {
  repo: string;
  laneId: string;
  entry: HistoryEntry;
}

export function flattenEvents(snapshots: LaneSnapshot[]): FlatEvent[] {
  const out: FlatEvent[] = [];
  for (const { repo, lane } of snapshots) {
    for (const entry of lane.history) {
      out.push({ repo, laneId: lane.id, entry });
    }
  }
  out.sort((a, b) => a.entry.at.localeCompare(b.entry.at));
  return out;
}
