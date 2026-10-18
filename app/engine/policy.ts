// Resolving which PolicyRule actually governs a changeset -- the one
// function both the merge backstop (engine/lane.ts's answer()) and
// every posting-time call site (agent/scriptedWork.ts,
// cli/commands/repo-submit.ts, the policy_set tool) share, so "what
// does touching these paths require" is computed exactly once, not
// reimplemented at each call site with its own chance to drift.
import type { PathPolicyRule, PolicyMode, RepoPolicy } from "./types.js";

// A repo with no policies set behaves exactly as before this feature
// existed: any agent may have its own review approved under
// self_review, no vote, no second approver required. _repo defaults
// to the strictest mode on purpose -- a brand-new repo's own Policy
// document shouldn't be quietly loosenable by a single Coordinator;
// an Owner always bypasses it
// regardless (see engine/lane.ts's writePolicy gate).
export const DEFAULT_REPO_POLICY: RepoPolicy = {
  visibility: "public",
  _repo: { mode: "vote_quorum" },
  policies: [{ path: "**", mode: "self_review" }],
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

/** A policy persisted before `_repo`/`policies` existed (just `{visibility, require_changeset_review}`) reads back with both fields missing -- every readPolicy implementation runs its result through this instead of trusting the stored JSON's shape directly, so an old repo's Policy document behaves exactly like a new repo's default rather than crashing resolvePolicyMode on an undefined `.policies`. */
export function normalizePolicy(raw: Partial<RepoPolicy> & { visibility: RepoPolicy["visibility"] }): RepoPolicy {
  return {
    visibility: raw.visibility,
    _repo: raw._repo ?? DEFAULT_REPO_POLICY._repo,
    policies: raw.policies ?? DEFAULT_REPO_POLICY.policies,
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

/** Every rule in `policy.policies` whose glob matches `path`, most-specific first. Empty if nothing matches (callers fall back to `self_review`, matching a repo with no "**" rule of its own). */
function matchingRules(policy: RepoPolicy, path: string): PathPolicyRule[] {
  return policy.policies.filter((r) => globToRegExp(r.path).test(path)).sort((a, b) => specificity(b.path) - specificity(a.path));
}

/** The one rule that governs a single touched path: its most specific matching glob, or a bare self_review default if nothing in `policies` matches at all (should only happen for a hand-edited policy document missing its own "**" fallback). */
export function resolvePathRule(policy: RepoPolicy, path: string): PathPolicyRule {
  return matchingRules(policy, path)[0] ?? { path: "**", mode: "self_review" };
}

/** The rule that governs a whole changeset: the strictest of each touched path's own most-specific rule. A changeset with no files (shouldn't happen, but cheap to handle) resolves to `direct`, since there's nothing to gate. */
export function resolvePolicyMode(policy: RepoPolicy, paths: string[]): PathPolicyRule {
  if (paths.length === 0) return { path: "**", mode: "direct" };
  return paths.map((p) => resolvePathRule(policy, p)).reduce((strictest, rule) => (stricterMode(strictest.mode, rule.mode) === rule.mode ? rule : strictest));
}
