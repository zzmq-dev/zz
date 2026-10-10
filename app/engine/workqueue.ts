// The generic work-queue machinery over a Lane's ask/answer history:
// which asks are claimable right now, and the claim -> work -> answer
// loop. Built so a later backend swap (a real shared queue, multiple
// concurrent actors) changes where claimableAsks reads from, not the
// shape of the loop itself.
import { ask, answer, ASK_SCOPE } from "./lane.js";
import { listLanes, readLane } from "./store.js";
import type { AnswerEntry, AskEntry, AskKind, Lane } from "./types.js";

function isAnswer(entry: Lane["history"][number]): entry is AnswerEntry {
  return entry.type === "ANSWER";
}

function isAsk(entry: Lane["history"][number]): entry is AskEntry {
  return entry.type === "ASK";
}

function isResolved(lane: Lane, askId: string, actions: Array<"grant" | "complete">): boolean {
  return lane.history.some((e) => isAnswer(e) && e.ask === askId && actions.includes(e.action as "grant" | "complete"));
}

/**
 * Who currently holds the claim on an ask, if anyone -- the actual
 * lease this project didn't have until now. A claim_request targeting
 * this ask, once granted, makes its `from` the holder; a later granted
 * claim_request on the same target (e.g. the same actor resuming after
 * a failed attempt) replaces the holder, but there's still always at
 * most one at a time. Nothing here expires a claim on its own; a holder
 * only changes by a new claim_request being granted. There's
 * deliberately no separate "release" -- the ask leaving the claimable
 * set entirely once it's answered is what ends the need for a holder.
 */
function claimHolder(lane: Lane, askId: string): string | null {
  let holder: string | null = null;
  for (const e of lane.history) {
    if (e.type !== "ASK" || e.kind !== "claim_request") continue;
    if ((e.payload as { target?: string } | undefined)?.target !== askId) continue;
    const granted = lane.history.some((a) => a.type === "ANSWER" && a.ask === e.id && a.action === "grant");
    if (granted) holder = e.from;
  }
  return holder;
}

/**
 * Every Ask with no matching Answer yet, where every id in depends_on
 * already has a "grant"/"complete" Answer, actor is permitted to act on
 * it (ASK_SCOPE), and it isn't already held by some other actor's
 * claim. Sorted by priority (descending); order among equal priority is
 * unspecified on purpose -- this is the query a real concurrent actor
 * runs against a shared queue, not a scheduling promise.
 */
export function claimableAsks(lane: Lane, actor: string): AskEntry[] {
  const answeredAskIds = new Set(lane.history.filter(isAnswer).map((e) => e.ask));
  return lane.history
    .filter(isAsk)
    .filter((a) => !answeredAskIds.has(a.id))
    .filter((a) => (a.depends_on ?? []).every((depId) => isResolved(lane, depId, ["grant", "complete"])))
    .filter((a) => ASK_SCOPE[a.kind] === "open" || lane.coordinators.includes(actor))
    .filter((a) => {
      const holder = claimHolder(lane, a.id);
      return holder === null || holder === actor;
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export type WorkScope = "coordinator" | "contributor" | "all";

export interface ClaimableEntry {
  repo: string;
  laneId: string;
  ask: AskEntry;
  /** True if `actor` already holds a granted claim on this ask (e.g. a previous attempt claimed it but didn't finish) -- no need to claim it again. */
  alreadyClaimed: boolean;
}

/**
 * `claimableAsks`, generalized across every Lane in a set of repos: the
 * "an agent doesn't know its role up front, it just knows what repos it
 * cares about and sends its identity" mechanism. Access filtering itself
 * is unchanged -- still `claimableAsks` per lane, keyed off
 * `lane.coordinators` -- this just aggregates it. `scope` is a separate,
 * client-side convenience filter on top of that (e.g. so a coordinator
 * can ask for only coordinator-scope work without also being handed every
 * open-scope ask it's merely *permitted* to pick up).
 */
export function claimableAcrossRepos(repos: { repo: string; stateDir: string }[], actor: string, scope: WorkScope = "all"): ClaimableEntry[] {
  const out: ClaimableEntry[] = [];
  for (const { repo, stateDir } of repos) {
    for (const lane of listLanes(stateDir)) {
      for (const a of claimableAsks(lane, actor)) {
        const isCoordScope = ASK_SCOPE[a.kind] === "coordinator";
        if (scope === "coordinator" && !isCoordScope) continue;
        if (scope === "contributor" && isCoordScope) continue;
        out.push({ repo, laneId: lane.id, ask: a, alreadyClaimed: claimHolder(lane, a.id) === actor });
      }
    }
  }
  return out;
}

/**
 * Claims one ask: `actor` posts a claim_request, and the lane's own
 * coordinator (lane.coordinators[0] -- the same identity as `actor` for
 * a self-coordinated lane, a genuinely different one for the repo Lane)
 * grants it. `actor` then does the work and posts the Answer to the
 * original ask with action "complete" and doWork()'s return value as
 * payload -- completing work doesn't need coordinator authority, only
 * granting the claim does.
 */
export async function claimAndAnswer(stateDir: string, laneId: string, theAsk: AskEntry, actor: string, doWork: (theAsk: AskEntry) => Promise<unknown>): Promise<AnswerPayloadResult> {
  const lane = readLane(stateDir, laneId);
  if (!lane) throw new Error(`no such lane: ${laneId}`);
  const grantedBy = lane.coordinators[0] ?? actor;
  const claim = ask(stateDir, laneId, { kind: "claim_request", from: actor, payload: { target: theAsk.id } });
  answer(stateDir, laneId, claim, { from: grantedBy, action: "grant", payload: { grant: `grant-${claim.id}` } });
  const payload = await doWork(theAsk);
  answer(stateDir, laneId, theAsk, { from: actor, action: "complete", payload });
  return { ask: theAsk, payload };
}

interface AnswerPayloadResult {
  ask: AskEntry;
  payload: unknown;
}

/**
 * Repeatedly finds the next claimable ask and runs the handler
 * registered for its kind, until nothing is claimable -- either the
 * queue is drained, or everything left is blocked on a dependency that
 * will never resolve (reported, not silently swallowed).
 */
export async function runWorkerLoop(stateDir: string, laneId: string, actor: string, handlers: Partial<Record<AskKind, (theAsk: AskEntry) => Promise<unknown>>>): Promise<void> {
  for (;;) {
    const lane = readLane(stateDir, laneId);
    if (!lane) throw new Error(`no such lane: ${laneId}`);
    const [next] = claimableAsks(lane, actor);
    if (!next) {
      const unanswered = lane.history.filter(isAsk).filter((a) => !lane.history.some((e) => isAnswer(e) && e.ask === a.id));
      if (unanswered.length) {
        console.error(`worker loop on ${laneId} stopped with ${unanswered.length} ask(s) still unanswered (blocked on an unmet dependency, or out of scope for ${actor}): ${unanswered.map((a) => a.id).join(", ")}`);
      }
      return;
    }
    const handler = handlers[next.kind];
    if (!handler) throw new Error(`no handler registered for ask kind "${next.kind}" (${next.id})`);
    await claimAndAnswer(stateDir, laneId, next, actor, handler);
  }
}
