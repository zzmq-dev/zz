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
import type { AnswerEntry, AskEntry, AskKind, InsightEntry, Lane, LaneRef, LaneStatus, RelatedLaneEntry, Trigger } from "./types.js";
import type { Rung, RungKind } from "./ladder.js";
import { REPO_RUNG_PATH } from "./ladder.js";
import type { ChangesetFile } from "./changeset.js";
import { resolvePolicyMode } from "./policy.js";

// The repo-wide Lane every other Lane traces back to -- never
// completes, always open, the one a bare `zz repo ask`/`zz work`
// targets by default. Named and exported here (not just a bare "_repo"
// literal scattered across call sites) specifically so this, the
// Lane-identity sense of that string, reads as its own distinct thing
// from the other two unrelated jobs "_repo" used to also do: the
// Ladder's own root rung path (REPO_RUNG_PATH, engine/ladder.ts -- a
// different system, happens to share this value, deliberately not
// unified with this) and a repo's Policy document's self-governance
// key (now RepoPolicy.policy_change, engine/types.ts -- renamed for
// exactly this reason). See https://github.com/zzmq-dev/zz/issues/35.
export const ORIGIN_LANE_ID = "_repo";

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
  input: { id: string; repo: string; name: string; objective: string; scope: string[]; proposedBy: string; origin?: LaneRef | null; reason?: string; coordinators?: string[]; committee?: string[] },
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
    // without an explicit committee still works fully autonomously --
    // narrow this explicitly (e.g. to a single human actor id) to
    // require real votes from a specific set of agents.
    committee: input.committee ?? coordinators,
    history: [],
    related_lanes: [],
  };
  await resolveBackend().writeLane(repo, lane);
  return lane;
}

/**
 * Adds `principal` to an EXISTING Lane's `coordinators` or `committee`
 * list -- the thing proposeLane's own `coordinators`/`committee`
 * params can't do, since those only ever apply at the moment a Lane is
 * first proposed. Needed because granting a repo-level Role
 * (site/content/docs/governance's "Planned: Tying Lane rights to repo
 * Roles") has no effect on any Lane's own authority today -- `_repo`
 * in particular is created lazily on first post with its committee
 * hardcoded to just the repo's owner, so a Coordinator-Role agent
 * granted afterward could claim open-scope work forever but never
 * actually cast a vote on any of it, with no way to fix that short
 * of this. Gated to the Lane's own current coordinators -- the same
 * "authority only comes from an explicit grant" principle every other
 * RBAC check here already follows, not a repo-Owner-only action,
 * since a Lane's coordinator is the one who actually knows who should
 * share its authority.
 */
export async function grantLaneRole(repo: string, laneId: string, input: { principal: string; as: "coordinator" | "committee"; grantedBy: string }): Promise<Lane> {
  return resolveBackend().withLane(repo, laneId, (lane) => {
    if (!lane.coordinators.includes(input.grantedBy)) {
      throw new Error(`"${input.grantedBy}" cannot grant Lane roles on "${laneId}" -- only one of its own coordinators (${lane.coordinators.join(", ")}) can.`);
    }
    const list = input.as === "coordinator" ? lane.coordinators : lane.committee;
    if (!list.includes(input.principal)) list.push(input.principal);
  });
}

export async function ask(repo: string, laneId: string, input: { kind: AskKind; from: string; payload?: unknown; depends_on?: string[]; priority?: number; deadline?: string }): Promise<AskEntry> {
  const entry: AskEntry = {
    id: randomId("ask"),
    type: "ASK",
    kind: input.kind,
    from: input.from,
    payload: input.payload,
    depends_on: input.depends_on,
    priority: input.priority,
    deadline: input.deadline,
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

/** Records that another Lane relates to this one -- the inverse of `Lane.origin` (which only lets you walk UP from a child lane to whatever created it): this lets the PARENT side enumerate its own children, e.g. runDecomposeWorkAsk (agent/scriptedWork.ts) populating this for the first time when a task splits into several sub-Lanes. Atomic via the same withLane as ask(), for the same reason. */
export async function addRelatedLane(repo: string, laneId: string, related: RelatedLaneEntry): Promise<void> {
  await resolveBackend().withLane(repo, laneId, (lane) => {
    lane.related_lanes.push(related);
  });
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

/**
 * Who currently holds the claim on an ask, if anyone. A claim_request
 * targeting this ask, once granted, makes its `from` the holder; a later
 * granted claim_request on the same target (e.g. the same actor resuming
 * after a failed attempt) replaces the holder. A later granted
 * claim_release (ask_release, agent/tools.ts) clears it back to null
 * instead -- giving up a claim without answering the claimed ask itself,
 * so it goes back to being claimable by anyone, including the same actor
 * later. lane.history is already in the order these were posted, so the
 * last granted claim/release event targeting this ask wins.
 *
 * Lives here, not in workqueue.ts (which re-exports it for every existing
 * caller) -- answer() below needs to call this from *inside* its own
 * atomic transaction, and workqueue.ts already imports from this file, so
 * importing the other way would be a cycle.
 */
export function claimHolder(lane: Lane, askId: string): string | null {
  let holder: string | null = null;
  for (const e of lane.history) {
    if (e.type !== "ASK" || (e.kind !== "claim_request" && e.kind !== "claim_release")) continue;
    if ((e.payload as { target?: string } | undefined)?.target !== askId) continue;
    const granted = lane.history.some((a) => a.type === "ANSWER" && a.ask === e.id && a.action === "grant");
    if (!granted) continue;
    holder = e.kind === "claim_request" ? e.from : null;
  }
  return holder;
}

export async function answer(repo: string, laneId: string, theAsk: AskEntry, input: { from: string; action: AnswerEntry["action"]; payload?: unknown }): Promise<AnswerEntry> {
  const entry: AnswerEntry = { id: randomId("answer"), type: "ANSWER", ask: theAsk.id, from: input.from, action: input.action, payload: input.payload, at: nowIso() };
  // Read outside withLane -- its own mutate callback stays synchronous
  // on purpose (see its own doc comment), and this is only needed for
  // the submit_changeset backstop below, a plain read with no
  // atomicity requirement of its own (a policy changing in the tiny
  // window between this read and the Lane write is an acceptable race,
  // same caliber as every other non-transactional read this protocol
  // already accepts elsewhere).
  const policy = theAsk.kind === "submit_changeset" && input.action === "complete" ? await resolveBackend().readPolicy(repo) : null;
  // Atomic: the duplicate-answer check, the RBAC check, and the write
  // all happen inside one transaction (Backend.withLane), so two
  // processes racing to answer the same Ask can't both pass the
  // "not yet answered" check before either one writes -- the second to
  // reach this lane blocks until the first commits, then sees its
  // answer and correctly reports "already answered" instead of
  // clobbering it.
  await resolveBackend().withLane(repo, laneId, (lane) => {
    // "vote" is the one action that's allowed more than once per ask --
    // one per distinct Committee member, not one ever for the whole
    // ask -- so the usual "already answered" rule checks per-actor
    // instead of "does any answer exist" for this action specifically.
    // tallyVotes is the only thing that ever posts the real, terminal
    // "complete" that closes a vote_request, and that one still only
    // ever happens once, caught by the same check as everything else.
    if (input.action === "vote") {
      const alreadyVoted = lane.history.some((e): e is AnswerEntry => e.type === "ANSWER" && e.ask === theAsk.id && e.action === "vote" && e.from === input.from);
      if (alreadyVoted) {
        throw Object.assign(new Error(`"${input.from}" already voted on ask ${theAsk.id} -- a ballot can't be recast. If you're checking whether the vote itself is resolved, use vote_tally instead of answering again.`), { resolved: true });
      }
    } else {
      // Exclude "vote" answers from this check -- a vote_request
      // accumulates several of those (one per actor) before its one
      // real terminal answer (tallyVotes's own "complete") exists at
      // all; without this exclusion, that terminal answer would always
      // see an existing "vote" entry and wrongly conclude it's a
      // duplicate.
      const existing = lane.history.find((e): e is AnswerEntry => e.type === "ANSWER" && e.ask === theAsk.id && e.action !== "vote");
      if (existing) {
        // `resolved: true` is a structural signal (see agent/loop.ts), not
        // just phrasing -- a model that keeps retrying this exact call
        // despite the message has, in practice, kept retrying it (observed
        // repeatedly); the loop itself ends on this signal instead of
        // depending on the model reading and acting on the text correctly.
        throw Object.assign(new Error(`ask ${theAsk.id} was already answered (action "${existing.action}" at ${existing.at}) -- no need to answer it again. If you're checking whether it's resolved, this error IS that confirmation: it is.`), { resolved: true });
      }
    }
    // The actual claim-exclusivity check -- found missing live: two
    // different real actors ("dev1" and "dev3"), each with their own
    // genuinely-unclaimed read of the same target ask, both posted
    // their own distinct claim_request and both got granted. The
    // "already answered" check just above only protects THIS
    // claim_request ask from being double-answered; it says nothing
    // about a second, different claim_request racing to grant itself
    // on the same target. Checked here, inside the same atomic
    // transaction the duplicate-answer check already runs in
    // (Backend.withLane serializes every answer() call against this
    // Lane), so whichever grant call actually reaches this point first
    // wins; the second one now sees the first's effect already applied
    // and is rejected, instead of both succeeding because both read
    // "unclaimed" before either had written anything.
    if (theAsk.kind === "claim_request" && input.action === "grant") {
      const target = (theAsk.payload as { target?: string } | undefined)?.target;
      const holder = target ? claimHolder(lane, target) : null;
      if (holder !== null && holder !== theAsk.from) {
        throw new Error(
          `ask ${theAsk.id} (claim_request, target "${target}") can't be granted -- "${holder}" already holds a granted claim on that target. Two actors raced to claim the same ask; this one lost. Check claimableAsks again before retrying.`,
        );
      }
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
    // Committee enforcement -- a vote/veto may only be cast by someone
    // this Lane actually lists in `committee`, which can be a strict
    // subset of coordinators (e.g. a single human actor id), not just
    // "any coordinator." changeset_review carries no equivalent check
    // here on purpose: it's open-scope, any Agent may submit one, and
    // Policy's approval mode (self_review/other_approver/vote_quorum/
    // vote_expiring) is what decides whether a given set of reviews is
    // actually sufficient to merge.
    if (ASK_SCOPE[theAsk.kind] === "committee" && !lane.committee.includes(input.from)) {
      throw new Error(
        `"${input.from}" cannot ${input.action} ask ${theAsk.id} (kind "${theAsk.kind}") -- that's a Committee decision, and this Lane's Committee is (${lane.committee.join(", ")}), which "${input.from}" isn't on.`,
      );
    }
    // A VETO only makes sense as a response to a specific proposed
    // change (site/content/docs/protocol: "Reject one specific
    // proposed change") -- rejecting anything else is just "deny".
    if (input.action === "veto" && theAsk.kind !== "changeset_review") {
      throw new Error(`"veto" only applies to a "changeset_review" ask -- ask ${theAsk.id} is "${theAsk.kind}". Use "deny" instead.`);
    }
    // A "vote" ballot only ever makes sense on a vote_request -- every
    // other kind resolves through grant/deny/complete.
    if (input.action === "vote" && theAsk.kind !== "vote_request") {
      throw new Error(`"vote" only applies to a "vote_request" ask -- ask ${theAsk.id} is "${theAsk.kind}". Use "grant"/"deny"/"complete" instead.`);
    }
    // The mechanical merge backstop: a submit_changeset may not be
    // completed without whatever Policy actually requires for the
    // files it touches actually having happened. depends_on is already
    // enforced at claim time (agent/tools.ts's ask_claim); this covers
    // a direct ask_answer call that skipped claiming entirely.
    if (theAsk.kind === "submit_changeset" && input.action === "complete" && policy) {
      const files = (theAsk.payload as { files?: { path: string }[] } | undefined)?.files ?? [];
      const rule = resolvePolicyMode(policy, files.map((f) => f.path));
      if (rule.mode === "direct") {
        // Nothing to check -- Policy allows this straight through.
      } else if (rule.mode === "vote_quorum" || rule.mode === "vote_expiring") {
        const voteId = (theAsk.depends_on ?? []).find((id) => lane.history.some((e) => e.type === "ASK" && e.id === id && e.kind === "vote_request"));
        const resolved = voteId !== undefined && lane.history.find((e): e is AnswerEntry => e.type === "ANSWER" && e.ask === voteId && e.action === "complete");
        const approved = !!resolved && (resolved.payload as { approved?: boolean } | undefined)?.approved === true;
        if (!approved) {
          throw new Error(
            `ask ${theAsk.id} ("submit_changeset") touches a path whose Policy rule is "${rule.mode}" -- it can't be completed without an approved, resolved vote_request in its depends_on. Post one (ask_post, kind "vote_request") and get vote_tally to close it first.`,
          );
        }
      } else {
        // self_review or other_approver -- both need a granted
        // changeset_review; other_approver additionally requires the
        // granting agent to differ from whoever proposed this Lane
        // (the Lane's own author), so an agent can't satisfy that
        // stricter mode by approving their own work.
        const reviewId = (theAsk.depends_on ?? []).find((id) => lane.history.some((e) => e.type === "ASK" && e.id === id && e.kind === "changeset_review"));
        const grant = reviewId !== undefined ? lane.history.find((e): e is AnswerEntry => e.type === "ANSWER" && e.ask === reviewId && e.action === "grant") : undefined;
        if (!grant) {
          throw new Error(
            `ask ${theAsk.id} ("submit_changeset") can't be completed without an approved changeset_review in its depends_on -- post one (ask_post, kind "changeset_review") and get it granted first.`,
          );
        }
        if (rule.mode === "other_approver" && grant.from === lane.trigger.proposed_by) {
          throw new Error(
            `ask ${theAsk.id} ("submit_changeset") touches a path whose Policy rule is "other_approver" -- its changeset_review was granted by "${grant.from}", the same agent who proposed this Lane. Get a different agent to review it.`,
          );
        }
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
    if (input.action === "veto") {
      // Terminal, like a denial, but site/content/docs/protocol is
      // explicit that it's a different thing ("ends that attempt"):
      // LaneStatus already had "vetoed" in its union, unused, before
      // this -- the first thing to actually set it.
      lane.status = "vetoed";
    } else if (input.action === "vote") {
      // Non-terminal (tallyVotes posts the real, terminal "complete"
      // once every expected Committee member has voted) -- a single
      // ballot doesn't move the Lane's own status at all.
    } else if (input.action === "grant") {
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
  // Auto-apply a granted Policy change -- the changeset_review
  // counterpart to tallyVotes's own "policy" decisionKind handling
  // below. Outside withLane on purpose, same reason the policy read
  // at the top of this function is: writePolicy is a real Backend
  // call, and withLane's own mutate callback stays synchronous.
  if (input.action === "grant" && theAsk.kind === "changeset_review") {
    const decision = (theAsk.payload ?? {}) as { decisionKind?: string; proposal?: Partial<import("./types.js").RepoPolicy> };
    if (decision.decisionKind === "policy" && decision.proposal) {
      const backend = resolveBackend();
      const current = await backend.readPolicy(repo);
      await backend.writePolicy(repo, { ...current, ...decision.proposal });
    }
  }
  return entry;
}

// Which actor may act on (claim, or grant/deny/complete) an ask of a
// given kind: "coordinator" means only someone in that lane's
// `coordinators` list, "committee" only someone in its `committee`
// list (can be a strict subset of coordinators), "open" means anyone.
// changeset_review is open-scope -- any Agent may submit a review
// opinion, with Policy's approval mode (self_review/other_approver/
// vote_quorum/vote_expiring) deciding what's actually sufficient to
// merge, not list membership. A property of the kind, not a central
// lock -- the query that reads this (engine/workqueue.ts's
// claimableAsks) is what a real concurrent actor would run against a
// shared queue.
export const ASK_SCOPE: Record<AskKind, "coordinator" | "open" | "committee"> = {
  claim_request: "coordinator",
  claim_release: "coordinator",
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
  changeset_review: "open",
  vote_request: "committee",
  // Posting (filing a report) is unrestricted -- ask() never
  // scope-checks. This governs who may act on one (complete it, which
  // runs the incident runbook) -- the Lane's coordinator, same
  // authority level site/content/docs/protocol gives an Owner to
  // "invoke any of [STOP/DROP/ROLL] directly."
  whistleblow: "coordinator",
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

/**
 * Posts an Insight -- a norm observed or a trap found (site/content/docs/nouns).
 * Two writes, not one, for two different reasons to read it back later:
 * a Lane-history entry (this Lane's own timeline, same as any Ask/Answer --
 * runIncidentRunbook's original use), and a repo-wide rung on the Ladder,
 * anchored and indexed the same way `ask`/`contributor` already are
 * (REPO_WIDE_ROOT_KINDS, engine/ladderNotes.ts), so a *different*,
 * unrelated agent touching this repo later can actually find it via
 * `ladder_search` -- Lane history alone only ever reaches someone already
 * working inside this one Lane, which defeats the entire point of an
 * Insight existing to prevent a mistake from being repeated by someone who
 * was never part of the Lane that found it the first time.
 */
export async function postInsight(repo: string, laneId: string, input: { kind: "norm" | "trap"; text: string; from: string }): Promise<InsightEntry> {
  const entry: InsightEntry = { type: "INSIGHT", kind: input.kind, text: input.text, from: input.from, at: nowIso() };
  await resolveBackend().withLane(repo, laneId, (lane) => {
    lane.history.push(entry);
  });
  const rung: Rung = {
    path: `insights/${randomId("insight")}`,
    kind: input.kind === "trap" ? "insight_trap" : "insight_norm",
    summary: input.text,
    sources: [],
    children: [],
  };
  try {
    await resolveBackend().writeLadder(repo, rung);
    await resolveBackend().appendRepoChildren(repo, [{ path: rung.path, kind: rung.kind }]);
  } catch (err) {
    // appendRepoChildren throws outright on a repo with no "_repo" rung
    // yet (never onboarded/built) -- the Lane-history write above
    // already landed by this point, so swallow this specific, expected
    // case rather than make the caller think posting the Insight failed
    // entirely. Anything else re-throws; a real failure here shouldn't
    // look like success.
    if (!/repo root has no note yet/.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  return entry;
}

export interface VoteTally {
  /** False while any expected Committee member (this Lane's `committee`) hasn't cast a ballot yet -- nothing is closed, no "complete" posted. */
  resolved: boolean;
  approved?: boolean;
  ballots: Record<string, "+1" | "+0" | "-0" | "-1">;
  missing: string[];
  /** True when this closed via its deadline passing with votes still missing, not a real quorum -- only possible for a "vote_expiring" Policy rule's own vote_request (payload.lazyEligible); every other vote_request still needs every committee member's ballot, same as always. */
  lazyConsensus?: boolean;
}

/**
 * Counts ballots on a vote_request and, once every one of this Lane's
 * committee members has voted, posts the real, terminal "complete"
 * that closes it -- the only thing that ever does. Demo-level
 * tallying (simple majority of +1 vs -1, +0/-0 count
 * toward quorum but not the result) -- the real design wants
 * stakes-scaled thresholds (a Role grant above Contributor needing a
 * bigger majority, an Owner succession needing zero -1s); not built
 * here. On approval of a "policy" decision, writes the passed change
 * through Backend.writePolicy -- the actual enforcement of what a
 * passed Policy vote means, not just a record that it happened.
 */
export async function tallyVotes(repo: string, laneId: string, askId: string, closedBy: string): Promise<VoteTally> {
  const backend = resolveBackend();
  const lane = await backend.readLane(repo, laneId);
  if (!lane) throw new Error(`no such lane "${laneId}" in ${repo}`);
  const theAsk = lane.history.find((e): e is AskEntry => e.type === "ASK" && e.id === askId);
  if (!theAsk || theAsk.kind !== "vote_request") throw new Error(`"${askId}" is not a "vote_request" ask in ${repo}/${laneId}`);
  const alreadyClosed = lane.history.some((e) => e.type === "ANSWER" && e.ask === askId && e.action === "complete");
  if (alreadyClosed) throw new Error(`vote "${askId}" is already closed -- no need to tally it again.`);

  const ballots: Record<string, "+1" | "+0" | "-0" | "-1"> = {};
  for (const e of lane.history) {
    if (e.type === "ANSWER" && e.ask === askId && e.action === "vote") {
      ballots[e.from] = (e.payload as { ballot: "+1" | "+0" | "-0" | "-1" }).ballot;
    }
  }
  const missing = lane.committee.filter((m) => !(m in ballots));
  const lazyEligible = (theAsk.payload as { lazyEligible?: boolean } | undefined)?.lazyEligible === true;
  const pastDeadline = !!theAsk.deadline && new Date(theAsk.deadline).getTime() <= Date.now();
  if (missing.length > 0 && !(lazyEligible && pastDeadline)) return { resolved: false, ballots, missing };

  // Past its deadline with votes still missing: only reachable at all
  // when lazyEligible gated the branch above, so this is exactly a
  // "vote_expiring" Policy rule's own offer going unengaged --
  // defaults to approved, the same "nobody objected" outcome lazy
  // consensus means everywhere else in the protocol. A real quorum
  // (missing.length === 0) still tallies for real below regardless of
  // lazyEligible, even if it happens to finish before its deadline.
  const lazyConsensus = missing.length > 0;
  const forVotes = Object.values(ballots).filter((b) => b === "+1").length;
  const againstVotes = Object.values(ballots).filter((b) => b === "-1").length;
  const approved = lazyConsensus || forVotes > againstVotes;

  await answer(repo, laneId, theAsk, { from: closedBy, action: "complete", payload: { approved, ballots, ...(lazyConsensus ? { lazyConsensus: true } : {}) } });

  if (approved) {
    const decision = (theAsk.payload ?? {}) as { decisionKind?: string; proposal?: Partial<import("./types.js").RepoPolicy> };
    if (decision.decisionKind === "policy" && decision.proposal) {
      const current = await backend.readPolicy(repo);
      await backend.writePolicy(repo, { ...current, ...decision.proposal });
    }
  }

  return { resolved: true, approved, ballots, missing, ...(lazyConsensus ? { lazyConsensus: true } : {}) };
}

/**
 * Lazy consensus (site/content/docs/protocol: "An Ask can carry a
 * deadline. If no one vetoes it before the deadline passes, it is
 * treated as approved") -- auto-grants a routine ask past its
 * deadline with no answer posted yet. Structurally refuses a
 * vote_request: that kind's whole point is that nothing about it ever
 * resolves without a real, counted Vote. A "vote_expiring" Policy
 * rule's own expiry is handled inside tallyVotes instead, not here --
 * its completion needs the same shape (action "complete",
 * payload.approved) a real tallied vote produces, which this
 * function's generic action "grant" can't give it.
 */
export async function checkLazyConsensus(repo: string, laneId: string, askId: string, closedBy: string): Promise<boolean> {
  const lane = await resolveBackend().readLane(repo, laneId);
  if (!lane) throw new Error(`no such lane "${laneId}" in ${repo}`);
  const theAsk = lane.history.find((e): e is AskEntry => e.type === "ASK" && e.id === askId);
  if (!theAsk) throw new Error(`no such ask "${askId}" in ${repo}/${laneId}`);
  if (theAsk.kind === "vote_request") {
    throw new Error(`"${askId}" is a "vote_request" -- lazy consensus never applies to one of these through checkLazyConsensus. A "vote_expiring" Policy rule's own expiry resolves through vote_tally instead once its deadline passes, not this function.`);
  }
  if (!theAsk.deadline || new Date(theAsk.deadline).getTime() > Date.now()) return false;
  const alreadyAnswered = lane.history.some((e) => e.type === "ANSWER" && e.ask === askId);
  if (alreadyAnswered) return false;
  await answer(repo, laneId, theAsk, { from: closedBy, action: "grant", payload: { lazyConsensus: true } });
  return true;
}

/**
 * ROLL: reverts an already-merged commit for real, by reusing
 * Backend.commitChangeset wholesale -- for each file that commit
 * touched, reads what it looked like at the commit's own parent and
 * submits that as the "new" state. No new git mechanism, just the
 * same primitive submit_changeset already commits through, run
 * backwards. A file the tainted commit itself added or deleted is
 * skipped (there's no delete primitive on a changeset yet -- the same
 * gap ladder-sync.ts already documents for the Ladder side); a
 * demo/incident-response example should use a modified file, not a
 * newly-added one, to actually exercise this.
 */
async function rollBackCommit(repo: string, targetSha: string, reason: string, actor: string): Promise<string> {
  const backend = resolveBackend();
  const commits = await backend.listCommits(repo);
  const target = commits.find((c) => c.sha === targetSha);
  if (!target) throw new Error(`ROLL: no such commit "${targetSha}" in ${repo}`);
  if (!target.parent) throw new Error(`ROLL: commit "${targetSha}" has no parent (it's the repo's root commit) -- nothing to revert to.`);
  const changes = await backend.diffCommit(repo, target);
  const files: ChangesetFile[] = [];
  for (const c of changes) {
    if (c.status !== "modified") continue;
    const oldContent = await backend.readFileAtCommit(repo, target.parent, c.path);
    files.push({ path: c.path, content: oldContent });
  }
  if (files.length === 0) {
    throw new Error(`ROLL: nothing revertible in "${targetSha}" -- every touched file was added or deleted, not modified, and there's no delete primitive yet to undo those.`);
  }
  return backend.commitChangeset(repo, { files, message: `Revert ${targetSha.slice(0, 8)}: ${reason}`, author: { name: "zz-incident", email: "zz-incident@zzmq.dev" } });
}

export interface IncidentResult {
  dropped: string[];
  rolled: { commit: string; revertCommit: string } | null;
}

/**
 * The incident runbook (site/content/docs/protocol's "Tainted work and
 * defecting agents" -- STOP/DROP/ROLL), run as the direct action of a
 * coordinator completing a "whistleblow" ask. STOP: this Lane only
 * (not a repo-wide or account-wide block -- out of scope for a demo).
 * DROP: denies the reported Agent's other still-pending Asks in this
 * same Lane. ROLL: reverts the named commit, if any, via
 * rollBackCommit. Always ends with a `trap`-kind Insight recording
 * what happened, whether or not a commit was rolled back.
 */
export async function runIncidentRunbook(repo: string, laneId: string, report: { targetAgent: string; targetCommit?: string; reason: string }, closedBy: string): Promise<IncidentResult> {
  // DROP before STOP: each deny below goes through the ordinary
  // answer() path, which (like any other deny/complete) bumps a
  // non-claim/review Lane's status back to "active" -- running DROP
  // first and setting the terminal "stopped" status last is what
  // keeps STOP's own effect from being clobbered by DROP's.
  const lane = await resolveBackend().readLane(repo, laneId);
  const dropped: string[] = [];
  if (lane) {
    const answeredAskIds = new Set(lane.history.filter((e): e is AnswerEntry => e.type === "ANSWER").map((e) => e.ask));
    const pending = lane.history.filter((e): e is AskEntry => e.type === "ASK" && e.from === report.targetAgent && !answeredAskIds.has(e.id));
    for (const p of pending) {
      await answer(repo, laneId, p, { from: closedBy, action: "deny", payload: { reason: `Dropped as part of incident response: ${report.reason}` } });
      dropped.push(p.id);
    }
  }

  let rolled: IncidentResult["rolled"] = null;
  if (report.targetCommit) {
    const revertSha = await rollBackCommit(repo, report.targetCommit, report.reason, closedBy);
    await mergeLaneLadder(repo, {
      path: `changesets/${revertSha}`,
      kind: "changeset",
      summary: `Incident response: reverts ${report.targetCommit.slice(0, 8)} -- ${report.reason}`,
      sources: [{ kind: "commit", ref: revertSha, title: `Revert ${report.targetCommit.slice(0, 8)}`, author: closedBy, at: nowIso() }],
      children: [],
    });
    rolled = { commit: report.targetCommit, revertCommit: revertSha };
  }

  await resolveBackend().withLane(repo, laneId, (lane) => {
    lane.status = "stopped";
  });

  await postInsight(repo, laneId, {
    kind: "trap",
    from: closedBy,
    text: `${report.targetAgent}: ${report.reason}${rolled ? ` -- ${report.targetCommit!.slice(0, 8)} reverted as ${rolled.revertCommit.slice(0, 8)}` : ""}`,
  });

  return { dropped, rolled };
}
