// Mirrors the schema documented at zzbin.dev/data-format/.
// Keep this file and that page in sync; the docs are the source of truth for shape.

export type Role = "owner" | "coordinator" | "committer" | "contributor" | "reader";

export interface RoleGrant {
  role: Role;
  scope: string;
  granted_by: string;
  at: string;
}

export interface AgentRoles {
  agent: string;
  grants: RoleGrant[];
}

// What it takes to get a change past the gate: "direct" (just commit,
// no gate at all), "self_review" (needs a changeset_review, same agent
// may author and approve it -- today's only behavior, still the
// default), "other_approver" (same, but the approver must differ from
// the author), "vote_quorum" (a real Committee vote, every committee
// member must cast a ballot, never resolves on silence), "vote_expiring" (the
// same vote, but opts into lazy consensus -- unanswered past its
// deadline auto-approves instead of staying open forever). Ordered
// loosest-to-strictest; engine/policy.ts's resolvePolicyMode relies on
// that order when more than one rule matches a changeset.
export type PolicyMode = "direct" | "self_review" | "other_approver" | "vote_quorum" | "vote_expiring";

export interface PolicyRule {
  mode: PolicyMode;
  /** vote_expiring only -- how long the vote stays open before lazy consensus can close it. */
  expiry_hours?: number;
}

export interface PathPolicyRule extends PolicyRule {
  /** A glob matched against a changeset's touched files -- "**" is the repo-wide fallback every new repo gets. */
  path: string;
}

// The canonical shape -- worker/src/repoMeta.ts's own RepoPolicy
// imports this instead of redeclaring it, so the governance layer
// (engine/lane.ts's tallyVotes, which writes a passed policy vote's
// outcome through Backend.writePolicy) and the Worker's own zz-meta
// storage never drift apart on what a Policy actually contains.
export interface RepoPolicy {
  visibility: "public" | "private";
  /** Governs changing this document itself -- deliberately a dedicated key, not a fake file path, so editing Policy is still subject to Policy without pretending it's a git-tracked file. An Owner always bypasses this; see engine/lane.ts's writePolicy gate. Named `policy_change`, not `_repo` (an earlier draft's name) -- "_repo" already means two other, unrelated things elsewhere (the root Lane's id, the Ladder's root rung path; see https://github.com/zzmq-dev/zz/issues/35), and reusing it a third time here was repeating the exact collision that issue exists to fix. engine/policy.ts's normalizePolicy migrates an already-persisted document's old `_repo` key on read. */
  policy_change: PolicyRule;
  /** Path-scoped rules for everything else; most-specific glob wins per touched path, strictest resulting mode wins across a whole changeset. */
  policies: PathPolicyRule[];
}

export type LaneStatus =
  | "proposed"
  | "open"
  | "claimed"
  | "active"
  | "merged"
  | "closed"
  | "vetoed"
  | "stopped";

export interface Trigger {
  kind: "manual";
  proposed_by: string;
  reason?: string;
}

export type AskKind =
  | "claim_request"
  // Gives up a claim held via an earlier claim_request, without
  // answering the claimed ask itself -- it goes back to being
  // claimable by anyone (including the same actor again later), unlike
  // "deny" (terminal) or just walking away (claim stays held forever,
  // invisible to claimableAsks). See engine/lane.ts's claimHolder
  // (re-exported from engine/workqueue.ts for existing callers), which
  // treats the latest granted claim_request/claim_release event for a
  // given target ask as authoritative -- and which answer() itself now
  // also checks at grant time, not just at query time.
  | "claim_release"
  | "review_request"
  | "change_request"
  | "coordinator_request"
  | "merge_request"
  | "rung_update_request"
  | "ingest_repo"
  | "analyze_changeset"
  | "add_filechange"
  | "summarize_changeset"
  // A generic task with no dedicated handler: payload.description is
  // prose for an agent to read like a prompt and figure out on its own,
  // rather than a kind-specific typed payload.
  | "work"
  // Proposes a real code change, with the full content of every
  // changed file as payload -- granting it is what actually commits
  // it (engine/changeset.ts's commitChangeset), the same pattern as
  // merge_request granting a Ladder write. No file ever needs to exist
  // on disk before this: the content lives entirely in the payload.
  | "submit_changeset"
  // A review of a proposed changeset, before it may be merged -- is
  // this what was actually asked for, does it stay in scope, does it
  // do anything that wasn't requested. Open-scope: any Agent may
  // submit one, an opinion rather than a privileged act -- what makes
  // a given set of reviews *sufficient* to merge is Policy's approval
  // mode (self_review/other_approver/vote_quorum/vote_expiring), not
  // membership on a restricted list. Separate from submit_changeset's
  // own (coordinator-scope) grant, which is purely mechanical: 3-way
  // merge, commit, Ladder writes. submit_changeset depends_on this, so
  // it can't even be claimed before a qualifying review has granted it
  // (see engine/lane.ts's ASK_SCOPE and the backstop check in
  // answer()).
  | "changeset_review"
  // Posted when a submit_changeset is denied specifically because
  // another change landed first and the proposal, based on a now-stale
  // snapshot, would have dropped it -- a real concurrency conflict
  // between two agents' work, not a bug in either one. Payload carries
  // the original proposal (files/message/summary) and the conflict
  // reason, so whoever claims this reconciles the two instead of
  // starting over from the task description alone.
  | "resolve_conflict"
  // A formal Committee ballot (site/content/docs/governance -- "for
  // decisions lazy consensus doesn't settle, such as granting Roles
  // above Contributor, changing Policy, or replacing an Owner, a
  // Committee holds a formal Vote"). Scope "committee" (ASK_SCOPE,
  // engine/lane.ts) -- resolved against the Lane's own `committee` list.
  // payload.decisionKind names what's being decided ("policy" |
  // "role_grant" | "owner_succession" | "other"); payload.proposal
  // carries the kind-specific detail (e.g. a RepoPolicy diff for
  // "policy"). Structurally exempt from lazy consensus (tallyVotes is
  // the only thing that ever closes one) UNLESS payload.lazyEligible
  // is explicitly true, which is the one case that also carries a
  // `deadline` -- a "vote_expiring" Policy rule's own offer, which
  // falls back to approved if nobody engages. Every other vote_request
  // (a Committee Vote on Policy itself under a stricter rule, a Role
  // grant above Contributor, Owner succession) carries no deadline at
  // all, which is the actual enforcement of "needs a real Vote, not
  // just nobody objecting in time."
  | "vote_request"
  // A report that some already-posted work is tainted (bad
  // provenance: leaked info, a reverted commit, a low-trust source) or
  // that an Agent defected (broke protocol: misreported scope, lied
  // about a claim) -- site/content/docs/protocol's "Tainted work and
  // defecting agents". Posting one is unrestricted (ask() itself never
  // scope-checks who may post, only engine/lane.ts's answer() checks
  // who may act on one) -- anyone can file a report. ASK_SCOPE below
  // is "coordinator" though: only the Lane's own coordinator (the
  // repo's Owner, for the root Lane) may complete it, which is the
  // direct action that runs the incident runbook (runIncidentRunbook,
  // engine/lane.ts) -- no review needed to undo already-reviewed-and-
  // now-discovered-bad work, but also not something a random reporter
  // can trigger just by filing the report. STOPs this Lane, DROPs the
  // reported Agent's other pending Asks in it, and (if
  // payload.targetCommit names an already-merged commit) ROLLs it back
  // with a real revert commit plus a `trap`-kind Insight recording why.
  | "whistleblow";

export interface AskEntry {
  id: string;
  type: "ASK";
  kind: AskKind;
  from: string;
  /** Kind-specific data: what's actually being asked for (a commit sha, a target ask id to claim, a Rung to merge, etc). */
  payload?: unknown;
  /** Ask ids (same lane) that must each have a "grant"/"complete" Answer before this one may be claimed. */
  depends_on?: string[];
  /** Higher = more urgent. A query-time sort hint (see engine/workqueue.ts), not a scheduling guarantee. */
  priority?: number;
  /**
   * Lazy consensus (site/content/docs/protocol -- "An Ask can carry a
   * deadline. If no one vetoes it before the deadline passes, it is
   * treated as approved"). ISO timestamp; checkLazyConsensus
   * (engine/lane.ts) auto-grants an ordinary ask past its deadline
   * with no veto/deny posted. Only ever set on a vote_request when
   * payload.lazyEligible is also true (a "vote_expiring" Policy rule's
   * own vote offer) -- tallyVotes itself is what closes that one past
   * its deadline, not checkLazyConsensus, since the completion needs a
   * real tally's shape (action "complete", payload.approved), not a
   * generic "grant". Every other vote_request carries no deadline at
   * all, which is what actually enforces "Policy/Role grants above
   * Contributor/Owner succession need a real Vote, not just nobody
   * objecting in time" rather than leaving it a convention someone
   * could forget.
   */
  deadline?: string;
  at: string;
}

export interface AnswerEntry {
  id: string;
  type: "ANSWER";
  /** The AskEntry.id this answers. */
  ask: string;
  from: string;
  // "veto": a hard, terminal rejection of one changeset_review by a
  // Committee member, for a design/priority disagreement
  // negotiation couldn't resolve -- distinct from "deny" (didn't meet
  // the bar) in both meaning and effect (sets the Lane to "vetoed", a
  // LaneStatus value that already existed, unused, before this).
  // "vote": one Committee member's ballot on a vote_request --
  // non-terminal and, uniquely, posted more than once per Ask (one per
  // distinct voter; engine/lane.ts's answer() special-cases this one
  // action instead of its usual one-answer-per-ask rule). payload:
  // {ballot: "+1" | "+0" | "-0" | "-1"}.
  action: "grant" | "deny" | "complete" | "veto" | "vote";
  /** Kind-specific data: a grant id for a claim, a built Rung for a work item, a ballot for a vote, etc. */
  payload?: unknown;
  at: string;
}

export interface InsightEntry {
  type: "INSIGHT";
  kind: "norm" | "trap";
  text: string;
  from: string;
  at: string;
}

export type HistoryEntry = AskEntry | AnswerEntry | InsightEntry;

export interface LaneRef {
  repo: string;
  lane: string;
}

export interface RelatedLaneEntry extends LaneRef {
  origin: LaneRef;
  status: LaneStatus;
}

export interface Lane {
  id: string;
  repo: string;
  origin: LaneRef | null;
  name: string;
  objective: string;
  status: LaneStatus;
  scope: string[];
  trigger: Trigger;
  coordinators: string[];
  // Who must cast a ballot on a vote_request (Committee membership --
  // "committee" ASK_SCOPE). changeset_review no longer reads this: it
  // is open-scope, any Agent may submit one, and Policy's approval
  // mode decides what's actually sufficient to merge. Defaults to
  // coordinators when not set explicitly, so existing fully-autonomous
  // flows keep working; narrow it to require a specific set of real
  // votes.
  committee: string[];
  budget?: { cap_usd: number; spent_usd: number };
  history: HistoryEntry[];
  related_lanes: RelatedLaneEntry[];
}

export interface Changeset {
  id: string;
  lane: string;
  read_set: string[];
  write_set: string[];
  reviews: { agent: string; verdict: "approve" | "request_changes"; at: string }[];
  merge_grant: {
    issued_to: string;
    issued_by: string;
    single_use: boolean;
    consumed_at: string | null;
  } | null;
}

export interface Decision {
  commit: string;
  lane: string;
  changeset: string;
  merged_via: "occ_fast_path" | "human_review";
  checks: string[];
}
