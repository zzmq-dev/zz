// Plain-text dumps of each view's full (unfiltered, untruncated) data,
// for the "y" copy-to-clipboard key in TabView -- separate from each
// component's own rendering so copying doesn't depend on whatever
// filter/scroll state that component's UI happens to be in right now.
import type { LaneSnapshot, FlatEvent } from "./types.js";
import type { LadderSnapshot } from "./useLadderTrees.js";
import type { ResolvedRung } from "../engine/ladderRender.js";

function describeEvent(e: FlatEvent): string {
  if (e.entry.type === "ASK") return `ASK   ${e.entry.kind} from ${e.entry.from}`;
  if (e.entry.type === "ANSWER") return `ANSWER ${e.entry.action} (${e.entry.ask}) from ${e.entry.from}`;
  return `NOTE  ${e.entry.kind}: ${e.entry.text}`;
}

export function laneListText(snapshots: LaneSnapshot[]): string {
  return snapshots.map(({ repo, lane }) => `${repo}\t${lane.id}\t${lane.status}\tcoord: ${lane.coordinators.join(", ")}`).join("\n");
}

export function liveLogText(events: FlatEvent[]): string {
  return events.map((e) => `${e.repo}\t${e.laneId}\t${describeEvent(e)}`).join("\n");
}

function flattenRungText(repo: string, rung: ResolvedRung, depth: number, out: string[]): void {
  out.push(`${"  ".repeat(depth)}[${rung.kind}] ${rung.path} -- ${rung.summary}`);
  for (const child of rung.children) flattenRungText(repo, child, depth + 1, out);
}

export function ladderText(snapshots: LadderSnapshot[]): string {
  const out: string[] = [];
  for (const { repo, tree } of snapshots) {
    out.push(`# ${repo}`);
    flattenRungText(repo, tree, 0, out);
  }
  return out.join("\n");
}
