// `zz repo policy show|set`: the human-by-hand counterpart to the
// policy_show/policy_set tools (agent/tools.ts). `show` is unrestricted
// read -- Policy is meant to be visible to a repo's Coordinators, not
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
import type { ClaimMode, ConflictMode, PolicyMode, RepoPolicy, RetentionMode } from "../../engine/types.js";

const VALID_MODES = ["direct", "self_review", "other_approver", "vote_quorum", "vote_expiring"];
const VALID_CLAIM_MODES = ["in_place", "shard"];
const VALID_RETENTION_MODES = ["keep", "dispose", "ttl"];
const VALID_CONFLICT_MODES = ["first_wins", "coordinator_decides", "vote", "mediate", "escalate_human"];

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
  if (!VALID_CONFLICT_MODES.includes(mode)) throw new Error(`conflict mode must be one of ${VALID_CONFLICT_MODES.join(", ")} -- got "${mode}". "first_wins" and "coordinator_decides" are actually implemented (#4, #6); "vote"/"mediate"/"escalate_human" fall back to first_wins's own behavior until each ships (#7, #9).`);
}

export async function repoPolicyShow(slug: string): Promise<void> {
  const policy = (await callRemoteTool(slug, "policy_show", {})) as RepoPolicy;
  console.log(JSON.stringify(policy, null, 2));
}

export interface RepoPolicySetOptions {
  repoRule?: string;
  path?: string;
  mode?: string;
  expiryHours?: string;
  claimModeManual?: string;
  claimModeAutonomous?: string;
  retentionMode?: string;
  retentionTtlHours?: string;
  conflictPath?: string;
  conflictMode?: string;
  as?: string;
}

export async function repoPolicySet(slug: string, opts: RepoPolicySetOptions): Promise<void> {
  const settingClaimMode = opts.claimModeManual || opts.claimModeAutonomous;
  const settingConflictRule = opts.conflictPath || opts.conflictMode;
  if (!opts.repoRule && !(opts.path && opts.mode) && !settingClaimMode && !opts.retentionMode && !settingConflictRule) {
    throw new Error(
      'Either --repo-rule <mode> (sets "policy_change"), --path <glob> --mode <mode> (upserts one "policies" entry), --claim-mode-manual/--claim-mode-autonomous <mode> (sets "claim_mode"), --retention-mode <mode> (sets "retention"), or --conflict-path <glob> --conflict-mode <mode> (upserts one "conflict_policies" entry), is required.',
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

  const identity = await resolveIdentity(opts.as);
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
    if (opts.repoRule) {
      validateMode(opts.repoRule);
      const policy = (await callRemoteTool(slug, "policy_set", { actor: identity.username, repo_rule: { mode: opts.repoRule, expiry_hours: expiryHours } })) as RepoPolicy;
      console.log(`Set ${slug}'s "policy_change" rule to "${opts.repoRule}".`);
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
      console.log(`Set ${slug}'s "retention" rule to "${opts.retentionMode}"${retentionTtlHours ? ` (ttl_hours: ${retentionTtlHours})` : ""}.${opts.retentionMode === "dispose" ? " This is destructive -- a completed work Lane's shard repo will be deleted the moment its Lane goes terminal." : ""}`);
      console.log(JSON.stringify(policy, null, 2));
    } else if (settingConflictRule) {
      validateConflictMode(opts.conflictMode!);
      const policy = (await callRemoteTool(slug, "policy_set", {
        actor: identity.username,
        conflict_path_rule: { path: opts.conflictPath, mode: opts.conflictMode },
      })) as RepoPolicy;
      console.log(`Set ${slug}'s conflict_policies rule for "${opts.conflictPath}" to "${opts.conflictMode}".`);
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
