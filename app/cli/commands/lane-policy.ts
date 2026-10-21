// `zz lane policy show|set`: the human-by-hand counterpart to the
// policy_show/policy_set tools (agent/tools.ts). `show` is unrestricted
// read -- Policy is meant to be visible to a Lane's Coordinators, not
// just enforced against them. `set` is the UNGATED write path: an
// Owner may always use it; a Coordinator only when whatever's being
// changed is itself under a "direct" Policy rule (enforced server-side,
// worker/src/webApp.ts's handleApiCallTool) -- anything stricter
// refuses here and has to go through the existing Ask/Vote protocol
// instead (post a changeset_review or vote_request with payload
// {decisionKind:"policy", proposal}; granting/tallying it applies the
// change for real, same mechanism the Committee Vote & Policy demo
// already uses).
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { ClaimMode, ConflictMode, ForkOwnershipMode, PolicyMode, RepoPolicy, RetentionMode } from "../../engine/types.js";

const VALID_MODES = ["direct", "self_review", "other_approver", "vote_quorum", "vote_expiring"];
const VALID_CLAIM_MODES = ["in_place", "shard"];
const VALID_RETENTION_MODES = ["keep", "dispose", "ttl"];
const VALID_CONFLICT_MODES = ["first_wins", "coordinator_decides", "vote", "mediate", "escalate_human"];
const VALID_FORK_OWNERSHIP_MODES = ["sole", "union"];

function validateMode(mode: string): asserts mode is PolicyMode {
  if (!VALID_MODES.includes(mode)) throw new Error(`--mode must be one of ${VALID_MODES.join(", ")} -- got "${mode}".`);
}

function validateClaimMode(mode: string): asserts mode is ClaimMode {
  if (!VALID_CLAIM_MODES.includes(mode)) throw new Error(`claim mode must be one of ${VALID_CLAIM_MODES.join(", ")} -- got "${mode}".`);
}

function validateRetentionMode(mode: string): asserts mode is RetentionMode {
  if (!VALID_RETENTION_MODES.includes(mode)) throw new Error(`retention mode must be one of ${VALID_RETENTION_MODES.join(", ")} -- got "${mode}".`);
}

function validateConflictMode(mode: string): asserts mode is ConflictMode {
  if (!VALID_CONFLICT_MODES.includes(mode)) throw new Error(`conflict mode must be one of ${VALID_CONFLICT_MODES.join(", ")} -- got "${mode}".`);
}

function validateForkOwnershipMode(mode: string): asserts mode is ForkOwnershipMode {
  if (!VALID_FORK_OWNERSHIP_MODES.includes(mode)) throw new Error(`fork-ownership mode must be one of ${VALID_FORK_OWNERSHIP_MODES.join(", ")} -- got "${mode}".`);
}

// A real, pre-existing bug found while testing #42, not introduced by
// it: this never passed allowAnonymous, even though policy_show is
// documented as an unrestricted read (Policy is meant to be visible to
// a Lane's Coordinators, not just enforced against them) -- so it
// silently required an ambient credential that nothing here ever set,
// confirmed live ("authentication required" against a public Lane).
export async function lanePolicyShow(slug: string): Promise<void> {
  const policy = (await callRemoteTool(slug, "policy_show", {}, true)) as RepoPolicy;
  console.log(JSON.stringify(policy, null, 2));
}

export interface LanePolicySetOptions {
  laneRule?: string;
  path?: string;
  mode?: string;
  expiryHours?: string;
  claimModeManual?: string;
  claimModeAutonomous?: string;
  retentionMode?: string;
  retentionTtlHours?: string;
  conflictPath?: string;
  conflictMode?: string;
  forkOwnership?: string;
  as?: string;
}

export async function lanePolicySet(slug: string, opts: LanePolicySetOptions): Promise<void> {
  const settingClaimMode = opts.claimModeManual || opts.claimModeAutonomous;
  const settingConflictRule = opts.conflictPath || opts.conflictMode;
  if (!opts.laneRule && !(opts.path && opts.mode) && !settingClaimMode && !opts.retentionMode && !settingConflictRule && !opts.forkOwnership) {
    throw new Error(
      'Either --lane-rule <mode> (sets "policy_change"), --path <glob> --mode <mode> (upserts one "policies" entry), --claim-mode-manual/--claim-mode-autonomous <mode> (sets "claim_mode"), --retention-mode <mode> (sets "retention"), --conflict-path <glob> --conflict-mode <mode> (upserts one "conflict_policies" entry), or --fork-ownership <mode> (sets "fork_ownership"), is required.',
    );
  }
  if (settingConflictRule && !(opts.conflictPath && opts.conflictMode)) {
    throw new Error("--conflict-path and --conflict-mode must be given together.");
  }
  if (settingClaimMode && !(opts.claimModeManual && opts.claimModeAutonomous)) {
    throw new Error("--claim-mode-manual and --claim-mode-autonomous must be set together -- claim_mode is replaced wholesale, not merged.");
  }
  const expiryHours = opts.expiryHours ? Number(opts.expiryHours) : undefined;
  const retentionTtlHours = opts.retentionTtlHours ? Number(opts.retentionTtlHours) : undefined;

  const identity = await resolveIdentity({ as: opts.as });
  setActiveToken(identity.token);

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await releaseIdentity(identity);
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));

  try {
    if (opts.laneRule) {
      validateMode(opts.laneRule);
      const policy = (await callRemoteTool(slug, "policy_set", { actor: identity.username, repo_rule: { mode: opts.laneRule, expiry_hours: expiryHours } })) as RepoPolicy;
      console.log(`Set ${slug}'s "policy_change" rule to "${opts.laneRule}".`);
      console.log(JSON.stringify(policy, null, 2));
    } else if (settingClaimMode) {
      validateClaimMode(opts.claimModeManual!);
      validateClaimMode(opts.claimModeAutonomous!);
      const policy = (await callRemoteTool(slug, "policy_set", {
        actor: identity.username,
        claim_mode: { manual: opts.claimModeManual, autonomous: opts.claimModeAutonomous },
      })) as RepoPolicy;
      console.log(`Set ${slug}'s "claim_mode" to {manual: "${opts.claimModeManual}", autonomous: "${opts.claimModeAutonomous}"}.`);
      console.log(JSON.stringify(policy, null, 2));
    } else if (opts.retentionMode) {
      validateRetentionMode(opts.retentionMode);
      const policy = (await callRemoteTool(slug, "policy_set", {
        actor: identity.username,
        retention_rule: { mode: opts.retentionMode, ttl_hours: retentionTtlHours },
      })) as RepoPolicy;
      console.log(`Set ${slug}'s "retention" rule to "${opts.retentionMode}"${retentionTtlHours ? ` (ttl_hours: ${retentionTtlHours})` : ""}.${opts.retentionMode === "dispose" ? " This is destructive -- a completed work Lane's own backing store will be deleted the moment its Lane goes terminal." : ""}`);
      console.log(JSON.stringify(policy, null, 2));
    } else if (settingConflictRule) {
      validateConflictMode(opts.conflictMode!);
      const policy = (await callRemoteTool(slug, "policy_set", {
        actor: identity.username,
        conflict_path_rule: { path: opts.conflictPath, mode: opts.conflictMode },
      })) as RepoPolicy;
      console.log(`Set ${slug}'s conflict_policies rule for "${opts.conflictPath}" to "${opts.conflictMode}".`);
      console.log(JSON.stringify(policy, null, 2));
    } else if (opts.forkOwnership) {
      validateForkOwnershipMode(opts.forkOwnership);
      const policy = (await callRemoteTool(slug, "policy_set", {
        actor: identity.username,
        fork_ownership_rule: { mode: opts.forkOwnership },
      })) as RepoPolicy;
      console.log(
        `Set ${slug}'s "fork_ownership" to "${opts.forkOwnership}".${opts.forkOwnership === "union" ? " A Lane forked from this one will add its forking actor on top of this Lane's own current owners, not replace them -- a one-time snapshot at fork time, never a live link." : ""}`,
      );
      console.log(JSON.stringify(policy, null, 2));
    } else {
      validateMode(opts.mode!);
      const policy = (await callRemoteTool(slug, "policy_set", { actor: identity.username, path_rule: { path: opts.path, mode: opts.mode, expiry_hours: expiryHours } })) as RepoPolicy;
      console.log(`Set ${slug}'s Policy rule for "${opts.path}" to "${opts.mode}".`);
      console.log(JSON.stringify(policy, null, 2));
    }
  } finally {
    await cleanup();
  }
}
