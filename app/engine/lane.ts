// The Lane lifecycle: ASK/ANSWER/claim/merge-grant as real functions,
// backend-agnostic (engine/backend.ts) -- a local clone and flat/SQLite
// files today, Cloudflare Artifacts and a Durable Object once that
// side exists (site/content/remote-backend/index.md). Every function
// here takes a repo slug, never a resolved local path; `resolveBackend()`
// is the only thing that knows where a given slug's data actually
// lives. The actual work queue (claiming, dependencies, the worker
// loop) lives in engine/workqueue.ts, built on top of the
// ask()/answer() primitives here.
import { randomBytes } from "node:crypto";
import { resolveBackend } from "./backend.js";
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

export async function proposeLane(
  repo: string,
  input: { id: string; repo: string; name: string; objective: string; scope: string[]; proposedBy: string; origin?: LaneRef | null; reason?: string; coordinators?: string[]; maintainers?: string[] },
): Promise<Lane> {
  const trigger: Trigger = { kind: "manual", proposed_by: input.proposedBy, reason: input.reason };
  const coordinators = input.coordinators ?? [input.proposedBy];
  const lane: Lane = {
    id: input.id,
    repo: input.repo,
    origin: input.origin ?? null,
    name: input.name,
    objective: input.objective,
    status: "proposed",
    scope: input.scope,
    trigger,
    coordinators,
    // Defaults to the same set as coordinators, so a Lane proposed
    // without explicit maintainers still works fully autonomously --
    // narrow this explicitly (e.g. to a single human actor id) to
    // require real sign-off on every changeset.
    maintainers: input.maintainers ?? coordinators,
    history: [],
    related_lanes: [],
  };
  await resolveBackend().writeLane(repo, lane);
  return lane;
}

export async function ask(repo: string, laneId: string, input: { kind: AskKind; from: string; payload?: unknown; depends_on?: string[]; priority?: number }): Promise<AskEntry> {
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
  // Atomic: two processes posting into the same Lane at once must not
  // let one's history.push silently overwrite the other's (see
  // Backend.withLane).
  await resolveBackend().withLane(repo, laneId, (lane) => {
    lane.history.push(entry);
  });
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

// Matches the actual shape observed in the wild (payload.files as an
// array of {path, content}) -- the same shape a real submit_changeset
// payload uses, which is exactly what makes this a shortcut rather
// than a different, legitimate structure.
function payloadEmbedsFiles(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f) => typeof f === "object" && f !== null && typeof (f as { path?: unknown }).path === "string" && typeof (f as { content?: unknown }).content === "string");
}

export async function answer(repo: string, laneId: string, theAsk: AskEntry, input: { from: string; action: AnswerEntry["action"]; payload?: unknown }): Promise<AnswerEntry> {
  const entry: AnswerEntry = { id: randomId("answer"), type: "ANSWER", ask: theAsk.id, from: input.from, action: input.action, payload: input.payload, at: nowIso() };
  // Atomic: the duplicate-answer check, the RBAC check, and the write
  // all happen inside one transaction (Backend.withLane), so two
  // processes racing to answer the same Ask can't both pass the
  // "not yet answered" check before either one writes -- the second to
  // reach this lane blocks until the first commits, then sees its
  // answer and correctly reports "already answered" instead of
  // clobbering it.
  await resolveBackend().withLane(repo, laneId, (lane) => {
    const existing = lane.history.find((e): e is AnswerEntry => e.type === "ANSWER" && e.ask === theAsk.id);
    if (existing) {
      // `resolved: true` is a structural signal (see agent/loop.ts), not
      // just phrasing -- a model that keeps retrying this exact call
      // despite the message has, in practice, kept retrying it (observed
      // repeatedly); the loop itself ends on this signal instead of
      // depending on the model reading and acting on the text correctly.
      throw Object.assign(new Error(`ask ${theAsk.id} was already answered (action "${existing.action}" at ${existing.at}) -- no need to answer it again. If you're checking whether it's resolved, this error IS that confirmation: it is.`), { resolved: true });
    }
    // RBAC enforcement: a coordinator-scope ask (ASK_SCOPE below) may
    // only be granted/completed/denied by one of this Lane's actual
    // coordinators -- the backend-level counterpart to claimableAsks
    // already filtering these out of a non-coordinator's claimable
    // list, so a client that calls answer() directly (bypassing that
    // filter) still can't act on something it was never entitled to see.
    if (ASK_SCOPE[theAsk.kind] === "coordinator" && !lane.coordinators.includes(input.from)) {
      throw new Error(
        `"${input.from}" cannot ${input.action} ask ${theAsk.id} (kind "${theAsk.kind}") -- that's coordinator-scope and "${input.from}" is not one of lane "${laneId}"'s coordinators (${lane.coordinators.join(", ")}).`,
      );
    }
    // Same enforcement for the Maintainer role (site/content/governance)
    // -- a changeset_review may only be granted/denied by someone this
    // Lane actually lists as a maintainer, which can be a strict
    // subset of coordinators (e.g. a single human actor id), not just
    // "any coordinator."
    if (ASK_SCOPE[theAsk.kind] === "maintainer" && !lane.maintainers.includes(input.from)) {
      throw new Error(
        `"${input.from}" cannot ${input.action} ask ${theAsk.id} (kind "${theAsk.kind}") -- that requires being one of lane "${laneId}"'s maintainers (${lane.maintainers.join(", ")}).`,
      );
    }
    // The mechanical merge backstop: a submit_changeset may not be
    // completed without a changeset_review it depends_on actually
    // having been granted. depends_on is already enforced at claim
    // time (agent/tools.ts's ask_claim); this covers a direct
    // ask_answer call that skipped claiming entirely.
    if (theAsk.kind === "submit_changeset" && input.action === "complete") {
      const reviewId = (theAsk.depends_on ?? []).find((id) => lane.history.some((e) => e.type === "ASK" && e.id === id && e.kind === "changeset_review"));
      const approved = reviewId !== undefined && lane.history.some((e) => e.type === "ANSWER" && e.ask === reviewId && e.action === "grant");
      if (!approved) {
        throw new Error(
          `ask ${theAsk.id} ("submit_changeset") can't be completed without an approved changeset_review in its depends_on -- post one (ask_post, kind "changeset_review") and get it granted by one of this lane's maintainers first.`,
        );
      }
    }
    // Observed directly (qwen3.8-27b on Groq): a contributor completing
    // a "work" ask sometimes shortcuts the protocol by embedding its
    // proposed file changes straight in the completion payload instead
    // of posting a "submit_changeset" ask -- which reports success
    // (ask_answer returns fine, the TUI shows "complete") while nothing
    // is ever committed, since no coordinator-scope ask exists for
    // anyone to pick up. A model reliably self-reports "done" here even
    // though it isn't; this blocks the shortcut structurally instead of
    // trusting that report.
    if (theAsk.kind === "work" && input.action === "complete" && payloadEmbedsFiles(input.payload)) {
      throw new Error(
        `ask ${theAsk.id} ("work") can't be completed with file changes embedded in the payload -- that never gets committed. Post a "submit_changeset" ask (ask_post, kind "submit_changeset", payload { files, message, summary }) into this lane first, then answer this ask complete once that's posted.`,
      );
    }
    lane.history.push(entry);
    if (input.action === "grant") {
      const nextStatus = STATUS_ON_GRANT[theAsk.kind];
      if (nextStatus) lane.status = nextStatus;
    } else if ((input.action === "complete" || input.action === "deny") && theAsk.kind !== "claim_request" && theAsk.kind !== "review_request") {
      // A claim_request grant moves status to "claimed" for exactly as
      // long as that claimed work is in flight -- without this, status
      // sticks at "claimed" forever after the very first claim, even
      // once the thing that was claimed is actually done. claim_request
      // and review_request themselves are the meta-asks that drive
      // STATUS_ON_GRANT above, not the work being claimed, so they're
      // excluded here.
      lane.status = "active";
    }
  });
  return entry;
}

// Which actor may act on (claim, or grant/deny/complete) an ask of a
// given kind: "coordinator" means only someone in that lane's
// `coordinators` list, "maintainer" only someone in its `maintainers`
// list (the Maintainer role, site/content/governance -- can be a
// strict subset of coordinators), "open" means anyone. A property of
// the kind, not a central lock -- the query that reads this
// (engine/workqueue.ts's claimableAsks) is what a real concurrent
// actor would run against a shared queue.
export const ASK_SCOPE: Record<AskKind, "coordinator" | "open" | "maintainer"> = {
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
  work: "open",
  submit_changeset: "coordinator",
  resolve_conflict: "open",
  changeset_review: "maintainer",
};

/**
 * Writes a Rung (or several top-level Rungs) into the repo's Ladder.
 * The only place git notes actually get mutated -- called from the
 * `merge_request` handler when the repo Lane's queue processes one, not
 * by whoever built the Ladder. No longer gated on any Lane's `.status`:
 * in the queue model, access is controlled by who's allowed to claim a
 * `merge_request` ask (ASK_SCOPE above), not by this function.
 */
export async function mergeLaneLadder(repo: string, laneLadder: Rung | Rung[]): Promise<void> {
  const rungs = Array.isArray(laneLadder) ? laneLadder : [laneLadder];
  await resolveBackend().writeLadder(repo, rungs);
  const asChildren = rungs.filter((r) => r.path !== REPO_RUNG_PATH);
  if (asChildren.length) {
    await resolveBackend().appendRepoChildren(repo, asChildren.map((r) => ({ path: r.path, kind: r.kind as RungKind })));
  }
}
