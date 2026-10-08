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

// A payload can carry a whole Rung (or array of Rungs), a commit, or
// just a few scalar fields -- print enough to identify what's being
// asked for/answered without dumping a full diff or Ladder subtree into
// every line of the log.
function summarizePayload(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  if (typeof payload !== "object") return String(payload);
  const p = payload as Record<string, unknown>;
  if (p.target) return `{target: ${p.target}}`;
  if (p.grant) return `{grant: ${p.grant}}`;
  if (p.commit && typeof p.commit === "object") {
    const c = p.commit as { sha?: string; message?: string };
    return `{commit: ${c.sha?.slice(0, 7)} "${c.message}"${p.change ? `, change: ${(p.change as { path?: string }).path}` : ""}}`;
  }
  if (p.path && p.changeSummary) return `{path: ${p.path}}`;
  if (p.ladder) {
    const ladder = p.ladder as { path?: string; kind?: string } | { path?: string; kind?: string }[];
    const rungs = Array.isArray(ladder) ? ladder : [ladder];
    return `{ladder: ${rungs.map((r) => `${r.kind}:${r.path}`).join(", ")}}`;
  }
  if ("path" in p && "kind" in p) return `{${p.kind}:${p.path}}`;
  const json = JSON.stringify(payload);
  return json.length > 80 ? json.slice(0, 77) + "..." : json;
}

function renderEntry(entry: HistoryEntry): string {
  if (entry.type === "ASK") {
    const deps = entry.depends_on?.length ? ` deps=[${entry.depends_on.join(",")}]` : "";
    return `ASK    ${entry.id.padEnd(14)} ${entry.kind.padEnd(18)} from ${entry.from}${deps} ${summarizePayload(entry.payload)}`;
  }
  if (entry.type === "ANSWER") {
    return `ANSWER ${entry.id.padEnd(14)} -> ${entry.ask.padEnd(14)} ${entry.action.padEnd(9)} from ${entry.from} ${summarizePayload(entry.payload)}`;
  }
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
