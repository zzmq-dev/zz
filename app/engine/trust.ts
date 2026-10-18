// Foundational Trust (#57): a continuous, earned score computed from
// real recorded outcomes, not a new persisted field anyone writes or
// increments directly. Nothing to keep in sync, nothing that can drift
// from the history it's supposed to reflect -- the same "computed view,
// not a fourth store" discipline the living contributors guide already
// applies to Principles/Policy/Insights/Charter (principle #5, invent
// as little as possible).
//
// Deliberately narrow for this first real pass: walks one Lane's own
// history (the origin Lane, by default -- a repo-wide identity, same
// anchor Insights and Charter already use), not every related_lane a
// repo might have. A fuller version that aggregates across a repo's
// whole Lane tree is real future work, not done here -- see
// site/content/docs/plans/directed-selection-implementation/#step-5-promote-trust-over-role.
//
// What this explicitly does NOT do yet, on purpose: gate anything.
// Nothing in engine/policy.ts, engine/lane.ts's RBAC checks, or
// worker/src/repoMeta.ts's Role enforcement reads this. Rewiring real
// access decisions around a score is a bigger, riskier change than
// making the score computable, and deserves its own careful pass with
// real review -- not something to fold into the same night this was
// first built. This file is the foundation that pass would build on.
import type { AnswerEntry, AskEntry, Lane } from "./types.js";
import { resolveBackend } from "./backend.js";

export interface TrustScore {
  agent: string;
  repo: string;
  laneId: string;
  /** Higher is more trusted. Can be negative. No fixed scale or ceiling -- this is a relative signal across agents in the same Lane, not a normalized 0-100 score. */
  score: number;
  details: {
    changesetsCompleted: number;
    changesetsDenied: number;
    reviewsGranted: number;
    reviewsVetoed: number;
    normsAuthored: number;
  };
}

function isAsk(e: Lane["history"][number]): e is AskEntry {
  return e.type === "ASK";
}
function isAnswer(e: Lane["history"][number]): e is AnswerEntry {
  return e.type === "ANSWER";
}

/**
 * Computes one agent's Trust in one Lane from its real recorded history:
 * changesets it submitted that merged vs. got denied, changeset_reviews
 * it granted that held vs. got vetoed (a veto is a design/priority
 * rejection, weighted heavier than an ordinary deny -- the same
 * distinction the protocol itself already draws), and `norm`-kind
 * Insights it authored. Denied changesets, vetoed reviews, and norms
 * found elsewhere in the repo (not authored by this agent) don't count
 * against or for them -- only their own recorded actions do.
 */
export async function computeTrust(repo: string, laneId: string, agent: string): Promise<TrustScore> {
  const lane = await resolveBackend().readLane(repo, laneId);
  if (!lane) throw new Error(`no such lane "${laneId}" in ${repo}`);

  const answersByAsk = new Map<string, AnswerEntry[]>();
  for (const e of lane.history) {
    if (!isAnswer(e)) continue;
    const list = answersByAsk.get(e.ask) ?? [];
    list.push(e);
    answersByAsk.set(e.ask, list);
  }

  let changesetsCompleted = 0;
  let changesetsDenied = 0;
  let reviewsGranted = 0;
  let reviewsVetoed = 0;
  let normsAuthored = 0;

  for (const e of lane.history) {
    if (isAsk(e) && e.from === agent) {
      const answers = answersByAsk.get(e.id) ?? [];
      if (e.kind === "submit_changeset") {
        if (answers.some((a) => a.action === "complete")) changesetsCompleted++;
        if (answers.some((a) => a.action === "deny")) changesetsDenied++;
      }
    }
    // A changeset_review's *grant* is itself an ANSWER, not an ASK --
    // credited to whoever granted/vetoed it (the reviewer), not
    // whoever posted the review ask (usually the contributor asking
    // for their own work to be reviewed).
    if (isAnswer(e) && e.from === agent) {
      const theAsk = lane.history.find((a): a is AskEntry => isAsk(a) && a.id === e.ask && a.kind === "changeset_review");
      if (theAsk) {
        if (e.action === "grant") reviewsGranted++;
        if (e.action === "veto") reviewsVetoed++;
      }
    }
    if (e.type === "INSIGHT" && e.from === agent && e.kind === "norm") normsAuthored++;
  }

  const score = changesetsCompleted - changesetsDenied + reviewsGranted - 2 * reviewsVetoed + normsAuthored;
  return { agent, repo, laneId, score, details: { changesetsCompleted, changesetsDenied, reviewsGranted, reviewsVetoed, normsAuthored } };
}
