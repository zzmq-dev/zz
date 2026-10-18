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
import type { PolicyMode, RepoPolicy } from "../../engine/types.js";

const VALID_MODES = ["direct", "self_review", "other_approver", "vote_quorum", "vote_expiring"];

function validateMode(mode: string): asserts mode is PolicyMode {
  if (!VALID_MODES.includes(mode)) throw new Error(`--mode must be one of ${VALID_MODES.join(", ")} -- got "${mode}".`);
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
  as?: string;
}

export async function repoPolicySet(slug: string, opts: RepoPolicySetOptions): Promise<void> {
  if (!opts.repoRule && !(opts.path && opts.mode)) {
    throw new Error('Either --repo-rule <mode> (sets "_repo"), or --path <glob> --mode <mode> (upserts one "policies" entry), is required.');
  }
  const expiryHours = opts.expiryHours ? Number(opts.expiryHours) : undefined;

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
      console.log(`Set ${slug}'s "_repo" rule to "${opts.repoRule}".`);
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
