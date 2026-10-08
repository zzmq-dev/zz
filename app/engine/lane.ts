// The Lane lifecycle: ASK/ANSWER/claim/merge-grant as real functions over
// the existing .zz/ persistence (engine/store.ts) and Ladder storage
// (engine/ladderNotes.ts), not just data types. Role-checking is deferred
// to a later step (see the plan) -- this step is about getting the
// protocol functions themselves working end to end.
import { readLane, writeLane } from "./store.js";
import { appendRepoChildren, writeLadder } from "./ladderNotes.js";
import type { AskEntry, AnswerEntry, Lane, LaneRef, LaneStatus, Trigger } from "./types.js";
import type { Rung, RungKind } from "./ladder.js";
import { REPO_RUNG_PATH } from "./ladder.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function proposeLane(
  stateDir: string,
  input: { id: string; repo: string; name: string; objective: string; scope: string[]; proposedBy: string; origin?: LaneRef | null; reason?: string },
): Lane {
  const trigger: Trigger = { kind: "manual", proposed_by: input.proposedBy, reason: input.reason };
  const lane: Lane = {
    id: input.id,
    repo: input.repo,
    origin: input.origin ?? null,
    name: input.name,
    objective: input.objective,
    status: "proposed",
    scope: input.scope,
    trigger,
    coordinators: [],
    history: [],
    related_lanes: [],
  };
  writeLane(stateDir, lane);
  return lane;
}

function requireLane(stateDir: string, laneId: string): Lane {
  const lane = readLane(stateDir, laneId);
  if (!lane) throw new Error(`no such lane: ${laneId}`);
  return lane;
}

export function ask(stateDir: string, laneId: string, input: { kind: AskEntry["kind"]; from: string }): AskEntry {
  const lane = requireLane(stateDir, laneId);
  const entry: AskEntry = { type: "ASK", kind: input.kind, from: input.from, at: nowIso() };
  lane.history.push(entry);
  writeLane(stateDir, lane);
  return entry;
}

const STATUS_ON_GRANT: Record<AskEntry["kind"], LaneStatus | null> = {
  claim_request: "claimed",
  review_request: "active",
  change_request: null,
  coordinator_request: null,
  merge_request: "merged",
};

export function answer(stateDir: string, laneId: string, theAsk: AskEntry, input: { from: string; action: AnswerEntry["action"] }): AnswerEntry {
  const lane = requireLane(stateDir, laneId);
  const entry: AnswerEntry = { type: "ANSWER", from: input.from, action: input.action, at: nowIso() };
  lane.history.push(entry);
  if (input.action === "grant") {
    const nextStatus = STATUS_ON_GRANT[theAsk.kind];
    if (nextStatus) lane.status = nextStatus;
  }
  writeLane(stateDir, lane);
  return entry;
}

/**
 * Merges a Lane's own local Ladder into the repo's Ladder -- the one
 * write path anything (replay, or later a live Lane) uses to actually
 * change stored Ladder state. Usually one top-level rung; a Lane whose
 * work produced several top-level entries (e.g. describing a whole
 * directory's immediate contents) passes an array instead.
 */
export async function mergeLaneLadder(repoDir: string, stateDir: string, lane: Lane, laneLadder: Rung | Rung[]): Promise<void> {
  if (lane.status !== "merged") throw new Error(`lane ${lane.id} is not merged (status: ${lane.status}); refusing to merge its Ladder`);
  const rungs = Array.isArray(laneLadder) ? laneLadder : [laneLadder];
  for (const rung of rungs) {
    await writeLadder(repoDir, stateDir, rung);
  }
  // The repo's own root rung is never a *child* of itself -- writing its
  // note (above) already embeds its own children correctly. Only other
  // top-level rungs get registered as new children of the repo root.
  const asChildren = rungs.filter((r) => r.path !== REPO_RUNG_PATH);
  if (asChildren.length) {
    await appendRepoChildren(repoDir, stateDir, asChildren.map((r) => ({ path: r.path, kind: r.kind as RungKind })));
  }
}
