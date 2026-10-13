// `zz top`: real-time dashboard over every Lane in the repos you care
// about -- watched live, not read back from a dump after the fact.
// Remote by default, like work/review; --local stays fully supported
// for the demo/local-backend path. Unlike work/review, `top` is
// read-only and has to work with ZERO config: no ~/.zz/config.json,
// no --repos, no login (remote) or other running zz process (local)
// all mean "show an empty/starter dashboard, not a crash" -- the
// repo-resolution chain below (configuredRepos -> /api/me/repos ->
// local discovery -> empty) is what makes that true, and Explore
// (reachable as its own tab, see TopApp.tsx) is how you find repos to
// add from inside the TUI instead of hand-editing config.json.
import React from "react";
import { render } from "ink";
import { execFileSync } from "node:child_process";
import { resolveRepo, isLocallyOnboarded, inferGitHubSlugFromCwd } from "../lib/repo.js";
import { configuredRepos, addRepoToConfig } from "../lib/config.js";
import { resolveCliBackendMode } from "../lib/backendMode.js";
import { apiFetch } from "../lib/api.js";
import { createRepoWatchStore } from "../lib/watchedRepos.js";
import { listRunningRepos } from "../lib/processRegistry.js";
import { TopApp } from "../../tui/TopApp.js";
import { enterFullscreen } from "../../tui/fullscreen.js";

export interface TopOptions {
  repos?: string[];
  local?: boolean;
}

/** No explicit config/--repos, local mode: union whatever other local `zz work`/`zz review` processes are watching with the current directory, if it's an onboarded GitHub-backed repo. Prints onboarding guidance and returns null (meaning "nothing to show, caller should exit") rather than ever rendering an empty-but-otherwise-normal TUI with no obvious next step. */
async function discoverLocalRepos(): Promise<string[] | null> {
  const running = listRunningRepos();
  const cwdSlug = inferGitHubSlugFromCwd();
  const cwdRepo = cwdSlug ? resolveRepo(cwdSlug) : null;
  const cwdOnboarded = cwdRepo ? await isLocallyOnboarded(cwdRepo) : false;
  const repos = cwdOnboarded && cwdSlug ? [...new Set([...running, cwdSlug])] : running;
  if (repos.length > 0) return repos;

  if (cwdSlug && !cwdOnboarded) {
    console.log(`Nothing to show yet. This directory looks like it's "${cwdSlug}" on GitHub, but it isn't onboarded into zz locally. Run:\n\n  zz ladder build ${cwdSlug}\n\nthen run \`zz top --local\` again.`);
  } else if (cwdRepo === null && cwdSlugLooksLikeGitRepo()) {
    console.log(`Nothing to show yet. This directory is a git repo, but its origin isn't a GitHub remote -- \`zz ladder build\` (zz's only onboarding path right now) needs one. Run \`zz work --local <owner/repo>\`/\`zz review --local <owner/repo>\` directly on a repo you've already onboarded, or use Explore (local mode browses the filesystem) from a terminal where one is nearby.`);
  } else {
    console.log("Nothing to show yet -- no other local zz process is running, and this directory isn't a git repo. Run `zz work`/`zz review` on a repo, or `zz ladder build owner/repo` to onboard one from GitHub, then run `zz top --local` again.");
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

export async function top(options: TopOptions): Promise<void> {
  // A read-only viewer, never an actor -- "zz-top-viewer" never needs
  // to be a real identity (nothing is ever posted/claimed as it).
  // requireIdentity: false is the whole point here -- remote mode
  // with no `zz login` session is a real, supported state (an
  // anonymous Explore search, an empty dashboard), not a crash.
  const mode = await resolveCliBackendMode({ ...options, requireIdentity: false });
  process.on("SIGINT", () => void mode.cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void mode.cleanup().then(() => process.exit(0)));

  const explicit = configuredRepos(options.repos);
  let repoSlugs: string[];
  if (explicit) {
    repoSlugs = explicit;
  } else if (mode.useRemote) {
    repoSlugs = mode.identity ? (await apiFetch<{ repos: { slug: string }[] }>("GET", "/api/me/repos")).repos.map((r) => r.slug) : [];
  } else {
    const discovered = await discoverLocalRepos();
    if (discovered === null) {
      await mode.cleanup();
      return; // discoverLocalRepos already printed guidance -- nothing to render
    }
    repoSlugs = discovered;
  }

  const resolvedRepos = repoSlugs.map((slug) => resolveRepo(slug));
  const watch = createRepoWatchStore(resolvedRepos);

  // The one "track" action Explore needs, in both its remote (search)
  // and local (directory browser) modes -- which underlying store it
  // writes to depends on the exact same three-way split the original
  // spec draws: a real server-side list when you're logged in to
  // remote, a local config file otherwise (not logged in remotely, or
  // local mode entirely, where there's no server concept at all).
  const onTrack = async (slug: string): Promise<void> => {
    if (mode.useRemote && mode.identity) {
      await apiFetch("POST", `/api/repos/${slug}/track`);
    } else {
      addRepoToConfig(slug);
    }
    watch.add(resolveRepo(slug));
  };

  enterFullscreen();
  render(React.createElement(TopApp, { watch, remote: mode.useRemote, local: !mode.useRemote, onTrack }));
}
