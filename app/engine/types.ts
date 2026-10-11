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
  | "resolve_conflict";

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
  at: string;
}

export interface AnswerEntry {
  id: string;
  type: "ANSWER";
  /** The AskEntry.id this answers. */
  ask: string;
  from: string;
  action: "grant" | "deny" | "complete";
  /** Kind-specific data: a grant id for a claim, a built Rung for a work item, etc. */
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
