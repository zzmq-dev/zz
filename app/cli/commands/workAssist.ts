// `zz work --assist`: a human-in-the-loop TUI session over the same
// claimable-ask queue `zz work` itself draws from -- you pick one ask
// (from whichever repos `zz top`'s own resolution chain says you're
// watching, see lib/watchedRepoResolution.ts), the model drafts a
// change or a review decision, and you chat with it (ask for revisions,
// push back, ask questions) before explicitly submitting it back into
// the protocol as a real ANSWER. Deliberately its own entry point, not
// a flag branch inside work()'s body: work() eagerly clones every
// configured repo and renders the always-on activity-log TUI, neither
// of which belongs here -- this never touches a repo until you've
// actually picked an ask out of it.
import React from "react";
import { render } from "ink";
import { resolveRepo } from "../lib/repo.js";
import { resolveCliBackendMode } from "../lib/backendMode.js";
import { resolveWatchedRepoSlugs } from "../lib/watchedRepoResolution.js";
import { createRepoWatchStore } from "../lib/watchedRepos.js";
import { authedCloneUrl } from "../lib/credentials.js";
import { resolveBackend, type Provider } from "../lib/resolveChatBackend.js";
import type { WorkScope } from "../../engine/workqueue.js";
import { AssistApp } from "../../tui/AssistApp.js";
import { enterFullscreen } from "../../tui/fullscreen.js";

export interface WorkAssistOptions {
  as?: string;
  agent?: string;
  repos?: string[];
  scope?: WorkScope;
  model?: string;
  provider?: Provider;
  local?: boolean;
}

export async function workAssist(options: WorkAssistOptions): Promise<void> {
  const scope: WorkScope = options.scope ?? "all";
  const provider = options.provider ?? "ollama";
  const backend = resolveBackend(provider, options.model);

  // Real writes happen here (claim/commit/submit/answer) -- unlike `zz
  // top`, this needs a real identity in remote mode, same as `zz work`.
  const mode = await resolveCliBackendMode(options);
  const { useRemote, identity } = mode;

  process.on("SIGINT", () => void mode.cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void mode.cleanup().then(() => process.exit(0)));

  const agent = options.agent ?? identity?.username;
  if (!agent) {
    console.error('no usable identity to act as -- run `zz login` first, or pass --agent/--as.');
    process.exitCode = 1;
    await mode.cleanup();
    return;
  }

  const repoSlugs = await resolveWatchedRepoSlugs(mode, options);
  if (repoSlugs === null) {
    await mode.cleanup();
    return; // resolveWatchedRepoSlugs already printed guidance -- nothing to render
  }

  const resolvedRepos = repoSlugs.map((slug) => resolveRepo(slug));
  const watch = createRepoWatchStore(resolvedRepos);

  enterFullscreen();
  const onExit = async () => {
    await mode.cleanup();
  };
  render(
    React.createElement(AssistApp, {
      watch,
      agent,
      scope,
      useRemote,
      backend,
      modeRun: mode.run,
      authedCloneUrlFor: identity ? (slug: string) => authedCloneUrl(identity.apiBase, identity.token, slug) : undefined,
      onExit,
    }),
  );
}
