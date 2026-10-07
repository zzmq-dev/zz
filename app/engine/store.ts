// Minimal .zz/ persistence: plain JSON files on disk, one per Lane/Role.
// Stands in for the real Durable Object + .zz/ commit flow (see architecture.md)
// until this slice is proven and gets deployed. Swapping the backing store
// later shouldn't require changing anything above this module's interface.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRoles, Lane } from "./types.js";

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

// Ladder storage lives in git notes (see engine/ladderNotes.ts), not here:
// a rung is an annotation on a git object, not a standalone coordination
// record the way a Lane or Role grant is.
