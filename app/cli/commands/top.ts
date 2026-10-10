// `zz top`: real-time dashboard over every Lane in the repos you care
// about (same local config as `zz work`) -- watched live, not read back
// from a dump after the fact.
import React from "react";
import { render } from "ink";
import { resolveRepo } from "../lib/repo.js";
import { readConfig } from "../lib/config.js";
import { TopApp } from "../../tui/TopApp.js";
import { enterFullscreen } from "../../tui/fullscreen.js";

export interface TopOptions {
  repos?: string[];
}

export async function top(options: TopOptions): Promise<void> {
  const config = readConfig({ agent: "zz-top-viewer", repos: options.repos });
  const resolvedRepos = config.repos.map((slug) => resolveRepo(slug));
  enterFullscreen();
  render(React.createElement(TopApp, { repos: resolvedRepos.map((r) => ({ repo: r.slug, repoDir: r.repoDir, stateDir: r.stateDir })) }));
}
