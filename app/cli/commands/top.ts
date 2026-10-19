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
import { login } from "./login.js";
import { clearCredentials } from "../lib/credentials.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import { ask } from "../../engine/lane.js";
import { readConfig } from "../lib/config.js";
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

  // Works the same regardless of --local: login/logout is always
  // about the real remote identity (~/.zz/credentials.json), which
  // other commands read independently of whatever backend *this*
  // session happens to be watching with.
  const onLogin = () => login({ quiet: true });
  const onLogout = () => {
    clearCredentials();
  };

  // A plain "work" ask (payload.description), same shape `zz ask post`
  // itself posts -- just into whichever lane was actually selected,
  // not always "_repo". Remote mode goes through the real protocol
  // tool (callRemoteTool); local mode calls the engine primitive
  // directly -- NOT through remoteBackend, which throws on purpose for
  // every write method (see remoteBackend.ts's own notSupported) since
  // only the server side can make a Lane mutation atomic.
  const onPostAsk = async (repoSlug: string, laneId: string, description: string): Promise<void> => {
    if (mode.useRemote) {
      // LaneList's own "n" handler already blocks this unless its
      // `identity` prop is set, but don't rely on the UI guard alone --
      // posting as nobody (or worse, as some stale local-mode fallback)
      // to a real remote repo should never be possible even if that
      // check is ever bypassed.
      if (!mode.identity) throw new Error("not logged in -- press l to log in first");
      await callRemoteTool(repoSlug, "ask_post", { lane_id: laneId, kind: "work", from: mode.identity.username, payload: { description }, depends_on: [] });
    } else {
      let localAgent: string | undefined;
      try {
        localAgent = readConfig({ allowEmpty: true }).agent;
      } catch {
        // no ~/.zz/config.json agent set -- fall through to the default below
      }
      await ask(repoSlug, laneId, { kind: "work", from: localAgent ?? "local-user", payload: { description } });
    }
  };

  enterFullscreen();
  render(
    React.createElement(TopApp, {
      watch,
      remote: mode.useRemote,
      local: !mode.useRemote,
      onTrack,
      identityUsername: mode.identity?.username ?? null,
      onLogin,
      onLogout,
      onPostAsk,
    }),
  );
}
