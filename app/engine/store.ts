// Minimal .zz/ persistence: plain JSON files on disk, one per Lane/Role.
// Stands in for the real Durable Object + .zz/ commit flow (see architecture.md)
// until this slice is proven and gets deployed. Swapping the backing store
// later shouldn't require changing anything above this module's interface.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRoles, Lane } from "./types.js";
import type { Rung, StoredRung } from "./ladder.js";
import { flatten } from "./ladder.js";

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function zzRoot(repoStateDir: string) {
  return join(repoStateDir, ".zz");
}

export function readLane(repoStateDir: string, laneId: string): Lane | null {
  const path = join(zzRoot(repoStateDir), "lanes", `${laneId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Lane;
}

export function writeLane(repoStateDir: string, lane: Lane): void {
  const dir = join(zzRoot(repoStateDir), "lanes");
  ensureDir(dir);
  writeFileSync(join(dir, `${lane.id}.json`), JSON.stringify(lane, null, 2) + "\n");
}

export function listLanes(repoStateDir: string): Lane[] {
  const dir = join(zzRoot(repoStateDir), "lanes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Lane);
}

export function readRoles(repoStateDir: string, agent: string): AgentRoles | null {
  const path = join(zzRoot(repoStateDir), "roles", `${agent}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as AgentRoles;
}

export function writeRoles(repoStateDir: string, agentRoles: AgentRoles): void {
  const dir = join(zzRoot(repoStateDir), "roles");
  ensureDir(dir);
  writeFileSync(join(dir, `${agentRoles.agent}.json`), JSON.stringify(agentRoles, null, 2) + "\n");
}

export function writeDecision(repoStateDir: string, commitSha: string, decision: unknown): void {
  const dir = join(zzRoot(repoStateDir), "decisions");
  ensureDir(dir);
  writeFileSync(join(dir, `${commitSha}.json`), JSON.stringify(decision, null, 2) + "\n");
}

// One file per rung under .zz/ladder/, at a path mirroring the rung's own
// `path` (the code path it describes). Never load the whole Ladder at once.
function ladderFile(repoStateDir: string, rungPath: string): string {
  return join(zzRoot(repoStateDir), "ladder", `${rungPath}.json`);
}

export function readRung(repoStateDir: string, rungPath: string): StoredRung | null {
  const path = ladderFile(repoStateDir, rungPath);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as StoredRung;
}

export function writeRung(repoStateDir: string, rung: StoredRung): void {
  const path = ladderFile(repoStateDir, rung.path);
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(rung, null, 2) + "\n");
}

/** Writes an entire authored Rung tree as individual per-rung files. */
export function writeLadder(repoStateDir: string, root: Rung): void {
  for (const stored of flatten(root)) writeRung(repoStateDir, stored);
}

/** Reads one rung's own direct children (one disk read per child, not the whole tree). */
export function readRungChildren(repoStateDir: string, rung: StoredRung): StoredRung[] {
  return rung.children
    .map((childPath) => readRung(repoStateDir, childPath))
    .filter((r): r is StoredRung => r !== null);
}
