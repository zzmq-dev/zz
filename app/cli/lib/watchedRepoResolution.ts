// Shared "which repos am I watching" resolution -- originally `zz
// top`'s own logic, extracted so `zz work --assist`'s ask picker (which
// needs this same answer, but must never eagerly clone anything the way
// `zz work`'s normal body does) can reuse it verbatim instead of
// drifting out of sync with `zz top`'s own behavior.
import { execFileSync } from "node:child_process";
import { resolveRepo, isLocallyOnboarded, inferGitHubSlugFromCwd } from "./repo.js";
import { configuredRepos } from "./config.js";
import { apiFetch } from "./api.js";
import { listRunningRepos } from "./processRegistry.js";
import type { BackendMode } from "./backendMode.js";

/** No explicit config/--lanes, local mode: union whatever other local `zz work`/`zz review` processes are watching with the current directory, if it's an onboarded GitHub-backed repo. Prints onboarding guidance and returns null (meaning "nothing to show, caller should exit/show empty") rather than ever pretending there's something to watch. */
async function discoverLocalRepos(): Promise<string[] | null> {
  const running = listRunningRepos();
  const cwdSlug = inferGitHubSlugFromCwd();
  const cwdRepo = cwdSlug ? resolveRepo(cwdSlug) : null;
  const cwdOnboarded = cwdRepo ? await isLocallyOnboarded(cwdRepo) : false;
  const repos = cwdOnboarded && cwdSlug ? [...new Set([...running, cwdSlug])] : running;
  if (repos.length > 0) return repos;

  if (cwdSlug && !cwdOnboarded) {
    console.log(`Nothing to show yet. This directory looks like it's "${cwdSlug}" on GitHub, but it isn't onboarded into zz locally. Run:\n\n  zz ladder build ${cwdSlug}\n\nthen try again.`);
  } else if (cwdRepo === null && cwdSlugLooksLikeGitRepo()) {
    console.log(`Nothing to show yet. This directory is a git repo, but its origin isn't a GitHub remote -- \`zz ladder build\` (zz's only onboarding path right now) needs one. Run \`zz work --local <owner/name>\`/\`zz review --local <owner/name>\` directly on a Lane you've already onboarded, or use Explore (local mode browses the filesystem) from a terminal where one is nearby.`);
  } else {
    console.log("Nothing to show yet -- no other local zz process is running, and this directory isn't a git repo. Run `zz work`/`zz review` on a Lane, or `zz ladder build owner/name` to onboard one from GitHub, then try again.");
  }
  return null;
}

// A plain git-repo check (no GitHub remote needed) just to pick the
// right wording above -- inferGitHubSlugFromCwd() returning null is
// ambiguous between "not a git repo" and "git repo, no GitHub
// remote," and those two deserve different guidance.
function cwdSlugLooksLikeGitRepo(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Priority: --lanes (explicit, always wins) > the server's own
 * per-identity list, if logged in (never mixed with a local config file
 * that isn't scoped per-identity -- confirmed live: logging in as a
 * second account still showed the first account's repos, because
 * ~/.zz/config.json was being checked unconditionally before login
 * state at all) > ~/.zz/config.json (the fallback for the two cases
 * with no server-side list to use instead: remote but not logged in, or
 * local mode) > local discovery > empty.
 *
 * Never clones or otherwise touches disk beyond resolving paths --
 * callers that need an actual working tree (zz work's normal body, an
 * assist session once an ask is picked) do that themselves, deliberately
 * separate from "what am I watching" so browsing/picking never triggers
 * it as a side effect.
 *
 * Returns null only for the local-mode "truly nothing to watch" case
 * (discoverLocalRepos already printed onboarding guidance) -- callers
 * that would otherwise render a pointless empty view should treat that
 * as "print nothing more, exit," same as `zz top` always has; an empty
 * array (not logged in remotely, no config) is a normal state worth
 * still rendering a view for.
 */
export async function resolveWatchedRepoSlugs(mode: BackendMode, options: { repos?: string[] }): Promise<string[] | null> {
  if (options.repos && options.repos.length > 0) return options.repos;
  if (mode.useRemote && mode.identity) {
    return (await apiFetch<{ repos: { slug: string }[] }>("GET", "/api/me/repos")).repos.map((r) => r.slug);
  }
  const configured = configuredRepos();
  if (configured) return configured;
  if (mode.useRemote) return []; // not logged in, no config -- empty dashboard
  return discoverLocalRepos();
}
