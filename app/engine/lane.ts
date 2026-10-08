// The Lane lifecycle: ASK/ANSWER/claim/merge-grant as real functions over
// the existing .zz/ persistence (engine/store.ts) and Ladder storage
// (engine/ladderNotes.ts), not just data types. Role-checking is deferred
// to a later step (see the plan) -- this step is about getting the
// protocol functions themselves working end to end. The actual work
// queue (claiming, dependencies, the worker loop) lives in
// engine/workqueue.ts, built on top of the ask()/answer() primitives
// here.
import { randomBytes } from "node:crypto";
import { readLane, writeLane } from "./store.js";
import { appendRepoChildren, writeLadder } from "./ladderNotes.js";
import type { AnswerEntry, AskEntry, AskKind, Lane, LaneRef, LaneStatus, Trigger } from "./types.js";
import type { Rung, RungKind } from "./ladder.js";
import { REPO_RUNG_PATH } from "./ladder.js";

function nowIso(): string {
  return new Date().toISOString();
}

// Random, not sequential: ids are minted independently by whoever
// creates an Ask/Answer, with no shared counter to coordinate around --
// a monotonic counter is exactly the kind of contended state that breaks
// once there are multiple concurrent readers/writers of the same queue.
function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

export function proposeLane(
  stateDir: string,
  input: { id: string; repo: string; name: string; objective: string; scope: string[]; proposedBy: string; origin?: LaneRef | null; reason?: string; coordinators?: string[] },
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
    coordinators: input.coordinators ?? [input.proposedBy],
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

export function ask(stateDir: string, laneId: string, input: { kind: AskKind; from: string; payload?: unknown; depends_on?: string[]; priority?: number }): AskEntry {
  const lane = requireLane(stateDir, laneId);
  const entry: AskEntry = {
    id: randomId("ask"),
    type: "ASK",
    kind: input.kind,
    from: input.from,
    payload: input.payload,
    depends_on: input.depends_on,
    priority: input.priority,
    at: nowIso(),
  };
  lane.history.push(entry);
  writeLane(stateDir, lane);
  return entry;
}

// Only kinds that describe *this lane's own* lifecycle drive a status
// transition. Work-item kinds (ingest_repo, analyze_changeset, ...) and
// cross-lane messages (merge_request lands in a *different* lane's
// queue than the one whose work it's about) never do.
const STATUS_ON_GRANT: Partial<Record<AskKind, LaneStatus>> = {
  claim_request: "claimed",
  review_request: "active",
};

export function answer(stateDir: string, laneId: string, theAsk: AskEntry, input: { from: string; action: AnswerEntry["action"]; payload?: unknown }): AnswerEntry {
  const lane = requireLane(stateDir, laneId);
  const entry: AnswerEntry = { id: randomId("answer"), type: "ANSWER", ask: theAsk.id, from: input.from, action: input.action, payload: input.payload, at: nowIso() };
  lane.history.push(entry);
  if (input.action === "grant") {
    const nextStatus = STATUS_ON_GRANT[theAsk.kind];
    if (nextStatus) lane.status = nextStatus;
  }
  writeLane(stateDir, lane);
  return entry;
}

// Which actor may act on (claim, or grant/deny/complete) an ask of a
// given kind: "coordinator" means only someone in that lane's
// `coordinators` list; "open" means anyone. A property of the kind, not
// a central lock -- the query that reads this (engine/workqueue.ts's
// claimableAsks) is what a real concurrent actor would run against a
// shared queue.
export const ASK_SCOPE: Record<AskKind, "coordinator" | "open"> = {
  claim_request: "coordinator",
  merge_request: "coordinator",
  review_request: "coordinator",
  change_request: "coordinator",
  coordinator_request: "coordinator",
  rung_update_request: "coordinator",
  ingest_repo: "open",
  analyze_changeset: "open",
  add_filechange: "open",
  summarize_changeset: "open",
};

/**
 * Writes a Rung (or several top-level Rungs) into the repo's Ladder.
 * The only place git notes actually get mutated -- called from the
 * `merge_request` handler when the repo Lane's queue processes one, not
 * by whoever built the Ladder. No longer gated on any Lane's `.status`:
 * in the queue model, access is controlled by who's allowed to claim a
 * `merge_request` ask (ASK_SCOPE above), not by this function.
 */
export async function mergeLaneLadder(repoDir: string, stateDir: string, laneLadder: Rung | Rung[]): Promise<void> {
  const rungs = Array.isArray(laneLadder) ? laneLadder : [laneLadder];
  for (const rung of rungs) {
    await writeLadder(repoDir, stateDir, rung);
  }
  const asChildren = rungs.filter((r) => r.path !== REPO_RUNG_PATH);
  if (asChildren.length) {
    await appendRepoChildren(repoDir, stateDir, asChildren.map((r) => ({ path: r.path, kind: r.kind as RungKind })));
  }
}
