// `zz lane log <owner/repo>`: a chronological feed of every ASK/ANSWER
// across every Lane for a repo -- the protocol trail `ladder dump` shows
// the resulting content for, but not the process that produced it.
import { resolveRepo } from "../lib/repo.js";
import { listLanes } from "../../engine/store.js";
import type { HistoryEntry, Lane } from "../../engine/types.js";

export type LaneLogFormat = "text" | "json";

export interface LaneLogOptions {
  format?: LaneLogFormat;
  lane?: string;
  out?: string;
}

interface LogRow {
  at: string;
  lane: string;
  laneName: string;
  entry: HistoryEntry;
}

function flatten(lanes: Lane[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const lane of lanes) {
    for (const entry of lane.history) {
      rows.push({ at: entry.at, lane: lane.id, laneName: lane.name, entry });
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

function renderEntry(entry: HistoryEntry): string {
  if (entry.type === "ASK") return `ASK    ${entry.kind.padEnd(18)} from ${entry.from}`;
  if (entry.type === "ANSWER") return `ANSWER ${entry.action.padEnd(18)} from ${entry.from}`;
  return `INSIGHT ${entry.kind.padEnd(17)} from ${entry.from}: ${entry.text}`;
}

function renderText(lanes: Lane[], rows: LogRow[]): string {
  const lines: string[] = [];
  lines.push(`${lanes.length} lanes, ${rows.length} protocol events.`);
  lines.push("");
  for (const row of rows) {
    lines.push(`${row.at}  [${row.lane}] ${renderEntry(row.entry)}`);
  }
  lines.push("");
  lines.push("lanes:");
  for (const lane of lanes) {
    lines.push(`  [${lane.status}] ${lane.id} -- ${lane.name} (origin: ${lane.origin ? lane.origin.lane : "none"})`);
  }
  return lines.join("\n");
}

export async function laneLog(slug: string, options: LaneLogOptions): Promise<void> {
  const repo = resolveRepo(slug);
  let lanes = listLanes(repo.stateDir);
  if (options.lane) lanes = lanes.filter((l) => l.id === options.lane);
  const rows = flatten(lanes);

  const format = options.format ?? "text";
  const output = format === "json" ? JSON.stringify({ repo: repo.slug, lanes, events: rows }, null, 2) : renderText(lanes, rows);

  if (options.out) {
    await import("node:fs").then((fs) => fs.writeFileSync(options.out!, output));
    console.error(`wrote ${lanes.length} lanes, ${rows.length} events to ${options.out}`);
  } else {
    process.stdout.write(output + "\n");
  }
}
