// `zz top`: real-time dashboard over every Lane in the repos you care
// about (same local config as `zz work`) -- watched live, not read back
// from a dump after the fact. Remote by default, like work/review;
// --local stays fully supported for the demo/local-backend path.
import React from "react";
import { render } from "ink";
import { resolveRepo } from "../lib/repo.js";
import { readConfig } from "../lib/config.js";
import { resolveCliBackendMode } from "../lib/backendMode.js";
import { TopApp } from "../../tui/TopApp.js";
import { enterFullscreen } from "../../tui/fullscreen.js";

export interface TopOptions {
  repos?: string[];
  local?: boolean;
}

export async function top(options: TopOptions): Promise<void> {
  // A read-only viewer, never an actor -- "zz-top-viewer" never needs
  // to be a real identity (nothing is ever posted/claimed as it).
  // resolveCliBackendMode still resolves real credentials in remote
  // mode so the TUI's own reads (useLaneSnapshots/useLadderTrees's
  // callRemoteTool calls) are authed.
  const mode = await resolveCliBackendMode(options);
  process.on("SIGINT", () => void mode.cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void mode.cleanup().then(() => process.exit(0)));

  // Zero repos resolved (no config.json, no --repos) is a real, valid
  // state here -- an empty dashboard, not a crash -- unlike
  // work/review, which always need at least one repo to do anything.
  const config = readConfig({ agent: "zz-top-viewer", repos: options.repos, allowEmpty: true });
  const resolvedRepos = config.repos.map((slug) => resolveRepo(slug));
  enterFullscreen();
  render(React.createElement(TopApp, { repos: resolvedRepos.map((r) => ({ repo: r.slug, repoDir: r.repoDir, stateDir: r.stateDir })), remote: mode.useRemote }));
}
