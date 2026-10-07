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

export interface AskEntry {
  type: "ASK";
  kind: "claim_request" | "review_request" | "change_request" | "coordinator_request" | "merge_request";
  from: string;
  at: string;
}

export interface AnswerEntry {
  type: "ANSWER";
  from: string;
  action: "grant" | "deny" | "inform";
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
