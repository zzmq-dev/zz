// `zz top`: real-time dashboard over every Lane in the repos you care
// about -- watched live, not read back from a dump after the fact.
// Remote by default, like work/review; --local stays fully supported
// for the demo/local-backend path. Unlike work/review, `top` is
// read-only and has to work with ZERO config: no ~/.zz/config.json,
// no --repos, no login (remote) or other running zz process (local)
// all mean "show an empty/starter dashboard, not a crash" -- the
// repo-resolution chain (lib/watchedRepoResolution.ts, shared with
// `zz work --assist`'s own ask picker) is what makes that true, and
// Explore (reachable as its own tab, see TopApp.tsx) is how you find
// repos to add from inside the TUI instead of hand-editing config.json.
import React from "react";
import { render } from "ink";
import { resolveRepo } from "../lib/repo.js";
import { addRepoToConfig } from "../lib/config.js";
import { resolveCliBackendMode } from "../lib/backendMode.js";
import { apiFetch } from "../lib/api.js";
import { createRepoWatchStore } from "../lib/watchedRepos.js";
import { resolveWatchedRepoSlugs } from "../lib/watchedRepoResolution.js";
import { TopApp } from "../../tui/TopApp.js";
import { enterFullscreen } from "../../tui/fullscreen.js";

export interface TopOptions {
  repos?: string[];
  local?: boolean;
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

  const repoSlugs = await resolveWatchedRepoSlugs(mode, options);
  if (repoSlugs === null) {
    await mode.cleanup();
    return; // resolveWatchedRepoSlugs already printed guidance -- nothing to render
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
