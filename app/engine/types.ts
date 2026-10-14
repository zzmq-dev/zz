// Mirrors the schema documented at zzbin.dev/data-format/.
// Keep this file and that page in sync; the docs are the source of truth for shape.

export type Role = "owner" | "maintainer" | "committer" | "contributor" | "reader";

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

// The canonical shape -- worker/src/repoMeta.ts's own RepoPolicy
// imports this instead of redeclaring it, so the governance layer
// (engine/lane.ts's tallyVotes, which writes a passed policy vote's
// outcome through Backend.writePolicy) and the Worker's own zz-meta
// storage never drift apart on what a Policy actually contains.
export interface RepoPolicy {
  require_changeset_review: boolean;
  visibility: "public" | "private";
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
  // invisible to claimableAsks). See engine/workqueue.ts's claimHolder,
  // which treats the latest granted claim_request/claim_release event
  // for a given target ask as authoritative.
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
  // A Maintainer's review of a proposed changeset, before it may be
  // merged -- is this what was actually asked for, does it stay in
  // scope, does it do anything that wasn't requested. Separate from
  // submit_changeset's own (coordinator-scope) grant, which is purely
  // mechanical: 3-way merge, commit, Ladder writes. submit_changeset
  // depends_on this, so it can't even be claimed before a Maintainer
  // has granted it (see engine/lane.ts's ASK_SCOPE and the backstop
  // check in answer()).
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
  // engine/lane.ts) -- resolved against the Lane's own `maintainers`
  // list, same as changeset_review; Committee is not a separate list.
  // payload.decisionKind names what's being decided ("policy" |
  // "role_grant" | "owner_succession" | "other"); payload.proposal
  // carries the kind-specific detail (e.g. a RepoPolicy diff for
  // "policy"). Never carries a `deadline` -- a vote_request is
  // structurally exempt from lazy consensus (tallyVotes/engine/lane.ts
  // is the only thing that ever closes one), which is the actual
  // enforcement of "Policy needs a real Vote, not just nobody
  // objecting in time."
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
   * (engine/lane.ts) auto-grants an ask past its deadline with no
   * veto/deny posted. Never set on a vote_request -- that kind is
   * structurally exempt (tallyVotes is the only thing that ever closes
   * one), which is what actually enforces "Policy/Role grants above
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
  // Maintainer/Committee member, for a design/priority disagreement
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
  // Who may grant a changeset_review -- the Maintainer role from
  // site/content/governance/index.md ("Reviews and decides;
  // accountable for what merges"), distinct from coordinators (which
  // governs the mechanical merge step: commit_changeset,
  // ladder_write_rung). Defaults to coordinators when not set
  // explicitly, so existing fully-autonomous flows keep working;
  // narrow it (e.g. to a single human actor id) to require real human
  // sign-off.
  maintainers: string[];
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
