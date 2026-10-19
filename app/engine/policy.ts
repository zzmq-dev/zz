// Resolving which PolicyRule actually governs a changeset -- the one
// function both the merge backstop (engine/lane.ts's answer()) and
// every posting-time call site (agent/scriptedWork.ts,
// cli/commands/repo-submit.ts, the policy_set tool) share, so "what
// does touching these paths require" is computed exactly once, not
// reimplemented at each call site with its own chance to drift.
import type { ConflictMode, PathConflictPolicyRule, PathPolicyRule, PolicyMode, PolicyRule, RepoPolicy } from "./types.js";

// A repo with no policies set behaves exactly as before this feature
// existed: any agent may have its own review approved under
// self_review, no vote, no second approver required. policy_change
// defaults to the strictest mode on purpose -- a brand-new repo's own
// Policy document shouldn't be quietly loosenable by a single
// Coordinator; an Owner always bypasses it
// regardless (see engine/lane.ts's writePolicy gate).
export const DEFAULT_REPO_POLICY: RepoPolicy = {
  visibility: "public",
  policy_change: { mode: "vote_quorum" },
  policies: [{ path: "**", mode: "self_review" }],
  claim_mode: { manual: "in_place", autonomous: "shard" },
  retention: { mode: "keep" },
  conflict_policies: [{ path: "**", mode: "first_wins" }],
};

// Loosest to strictest -- resolveMode across several touched paths
// picks the LAST (strictest) of its matches, and this same order is
// what "more restrictive than" means wherever two modes get compared.
const MODE_STRICTNESS: Record<PolicyMode, number> = {
  direct: 0,
  self_review: 1,
  other_approver: 2,
  vote_expiring: 3,
  vote_quorum: 4,
};

export function stricterMode(a: PolicyMode, b: PolicyMode): PolicyMode {
  return MODE_STRICTNESS[a] >= MODE_STRICTNESS[b] ? a : b;
}

// Same loosest-to-strictest spirit as MODE_STRICTNESS above, for the
// orthogonal conflict-handling axis (#4) -- see ConflictMode's own doc
// comment (engine/types.ts) for the reasoning behind this order.
const CONFLICT_MODE_STRICTNESS: Record<ConflictMode, number> = {
  first_wins: 0,
  coordinator_decides: 1,
  vote: 2,
  mediate: 3,
  escalate_human: 4,
};

export function stricterConflictMode(a: ConflictMode, b: ConflictMode): ConflictMode {
  return CONFLICT_MODE_STRICTNESS[a] >= CONFLICT_MODE_STRICTNESS[b] ? a : b;
}

/**
 * Normalizes a raw, persisted Policy document into the current shape.
 * Handles three generations of drift, all read-time-only (nothing is
 * rewritten in storage until the next real write):
 *  - Pre-path-scoped-modes documents (just `{visibility,
 *    require_changeset_review}`) read back with `policy_change`,
 *    `policies`, and `claim_mode` all missing -- treated exactly like
 *    a new repo's default rather than crashing resolvePolicyMode on
 *    an undefined `.policies`.
 *  - Documents written between this feature's introduction and #35's
 *    rename, which used the now-retired key `_repo` for what's now
 *    `policy_change` (collided with the Lane id and Ladder rung path
 *    of the same literal string -- see engine/types.ts's RepoPolicy).
 *    A legacy `_repo` is honored if present and `policy_change` isn't.
 *  - Documents written before `claim_mode` existed (#37) -- read back
 *    missing that key entirely, defaulting to exactly the pre-#37
 *    behavior (manual in_place, autonomous shard).
 *  - Documents written before `retention` existed (#39) -- read back
 *    missing that key entirely, defaulting to "keep", the only mode
 *    that matches every repo's actual pre-#39 behavior (nothing was
 *    ever auto-deleted).
 *  - Documents written before `conflict_policies` existed (#4) --
 *    read back missing that key entirely, defaulting to
 *    `[{path: "**", mode: "first_wins"}]`, the only mode that matches
 *    every repo's actual pre-#4 behavior (deny the losing
 *    submit_changeset, repost against new HEAD).
 */
export function normalizePolicy(raw: Partial<RepoPolicy> & { visibility: RepoPolicy["visibility"]; _repo?: PolicyRule }): RepoPolicy {
  return {
    visibility: raw.visibility,
    policy_change: raw.policy_change ?? raw._repo ?? DEFAULT_REPO_POLICY.policy_change,
    policies: raw.policies ?? DEFAULT_REPO_POLICY.policies,
    claim_mode: raw.claim_mode ?? DEFAULT_REPO_POLICY.claim_mode,
    retention: raw.retention ?? DEFAULT_REPO_POLICY.retention,
    conflict_policies: raw.conflict_policies ?? DEFAULT_REPO_POLICY.conflict_policies,
  };
}

// Deliberately small: "*" (anything but "/") and "**" (anything,
// including "/") are the only wildcards -- enough for "src/core/**",
// "docs/*.md", "zz-policy.json", and the "**" repo-wide fallback,
// without pulling in a real glob dependency for a handful of patterns.
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${escaped}$`);
}

// "Most specific" is approximated as "most literal characters in the
// pattern" -- a plain filename beats "dir/*", which beats "dir/**",
// which beats "**". Simple, and exactly matches every case this
// feature actually needs (no two patterns so close in literal length
// that the approximation would pick the wrong one for a real repo).
function specificity(glob: string): number {
  return glob.replace(/\*\*?/g, "").length;
}

/** Every rule in `rules` whose glob matches `path`, most-specific first. Shared by both Policy axes (#4) -- one glob matcher, not two copies with their own chance to drift. */
function matchingPathRules<T extends { path: string }>(rules: T[], path: string): T[] {
  return rules.filter((r) => globToRegExp(r.path).test(path)).sort((a, b) => specificity(b.path) - specificity(a.path));
}

/** The one rule that governs a single touched path: its most specific matching glob, or a bare self_review default if nothing in `policies` matches at all (should only happen for a hand-edited policy document missing its own "**" fallback). */
export function resolvePathRule(policy: RepoPolicy, path: string): PathPolicyRule {
  return matchingPathRules(policy.policies, path)[0] ?? { path: "**", mode: "self_review" };
}

/** The rule that governs a whole changeset: the strictest of each touched path's own most-specific rule. A changeset with no files (shouldn't happen, but cheap to handle) resolves to `direct`, since there's nothing to gate. */
export function resolvePolicyMode(policy: RepoPolicy, paths: string[]): PathPolicyRule {
  if (paths.length === 0) return { path: "**", mode: "direct" };
  return paths.map((p) => resolvePathRule(policy, p)).reduce((strictest, rule) => (stricterMode(strictest.mode, rule.mode) === rule.mode ? rule : strictest));
}

/** conflict_policies' own equivalent of resolvePathRule -- same matcher, this axis's own bare default (first_wins, matching a repo with no "**" rule of its own). */
export function resolveConflictPathRule(policy: RepoPolicy, path: string): PathConflictPolicyRule {
  return matchingPathRules(policy.conflict_policies, path)[0] ?? { path: "**", mode: "first_wins" };
}

/** conflict_policies' own equivalent of resolvePolicyMode: the strictest of each touched path's own most-specific conflict rule. A changeset with no files resolves to first_wins, since there's nothing to collide over. */
export function resolveConflictMode(policy: RepoPolicy, paths: string[]): PathConflictPolicyRule {
  if (paths.length === 0) return { path: "**", mode: "first_wins" };
  return paths.map((p) => resolveConflictPathRule(policy, p)).reduce((strictest, rule) => (stricterConflictMode(strictest.mode, rule.mode) === rule.mode ? rule : strictest));
}
