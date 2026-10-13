// `zz top`: the real-time dashboard. Same building blocks as `zz
// work`'s view (TabView/LaneList/LiveLog/LadderView), just without an
// activity tab since `zz top` isn't itself running an agent -- it's
// purely a watcher. Plus Explore, reachable as an ordinary tab at any
// time (the plan's own requirement), for finding more repos to watch
// without quitting and hand-editing ~/.zz/config.json.
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Text, useInput } from "ink";
import { TabView } from "./TabView.js";
import { LaneList } from "./LaneList.js";
import { LiveLog } from "./LiveLog.js";
import { LadderView } from "./LadderView.js";
import { Explore } from "./Explore.js";
import { useLaneSnapshots } from "./useLaneSnapshots.js";
import { useLadderTrees } from "./useLadderTrees.js";
import { flattenEvents } from "./types.js";
import { laneListText, liveLogText, ladderText } from "./textExport.js";
import { GREEN, MUTED, YELLOW } from "./theme.js";

// Loose structural shape, not an import of cli/lib/watchedRepos.js's
// RepoWatchStore -- see WorkApp.tsx's identical comment for why
// (tui/ depends on cli/lib for plain function calls already, e.g.
// useLaneSnapshots.ts's callRemoteTool, but a prop TYPE stays
// structural so this component doesn't care which store implementation
// top.ts actually constructed).
interface RepoWatch {
  get(): { slug: string; repoDir: string; stateDir: string }[];
  subscribe(listener: () => void): () => void;
}

export function TopApp({
  watch,
  remote,
  local,
  onTrack,
  identityUsername,
  onLogin,
  onLogout,
  onPostAsk,
}: {
  watch: RepoWatch;
  /** Mirrors WorkApp's own prop: in remote mode, Lane/Ladder state lives on the deployed Worker, not in a local clone's flat files/git notes -- see useLaneSnapshots.ts/useLadderTrees.ts's own `remote` param. */
  remote: boolean;
  /** Picks which Explore variant renders: a search box (remote) or a filesystem browser (local) -- always the logical negation of `remote` today, but threaded through explicitly rather than re-derived, since "remote but acting on local paths" isn't a real combination this prop should ever have to represent. */
  local: boolean;
  /** Explore's "track" action -- top.ts builds this once, closing over whichever of (the track API, ~/.zz/config.json) actually applies, so Explore itself never needs to know the mode-specific rule. */
  onTrack: (slug: string) => Promise<void>;
  /** Whoever `zz login` already resolved to before this ever rendered (null if not logged in, or in --local mode) -- the "l" hotkey below can change this at runtime, so it's only the *initial* value. */
  identityUsername: string | null;
  /** Opens a browser for the OAuth flow and resolves once it completes -- `cli/commands/login.ts`'s own `login()`, called with `quiet: true` so its normal console.log output doesn't corrupt the alt-screen frame. */
  onLogin: () => Promise<string>;
  onLogout: () => void;
  /** LaneList's own "n" (post a new ask into the selected lane) -- see top.ts's own implementation for the remote/local split. */
  onPostAsk: (repo: string, laneId: string, description: string) => Promise<void>;
}) {
  const watchedRepos = useSyncExternalStore(watch.subscribe, watch.get);
  const repos = watchedRepos.map((r) => ({ repo: r.slug, repoDir: r.repoDir, stateDir: r.stateDir }));
  const snapshots = useLaneSnapshots(repos, 500, remote);
  const ladders = useLadderTrees(repos, 2000, remote);
  const [exploreEditing, setExploreEditing] = useState(false);
  const [laneEditing, setLaneEditing] = useState(false);
  const [identity, setIdentity] = useState(identityUsername);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // "l": log in if anon, log out if not -- a single toggle key rather
  // than separate ones, since only one of the two actions is ever
  // actually available at a time. Gated on !exploreEditing the same
  // way TabView's own hotkeys are (passed down as inputPaused below):
  // Explore's search box is free text, and "l" is a letter someone
  // might actually type into a search query.
  // NOTE: logging in as a different identity doesn't re-resolve which
  // repos this session watches -- that list was fixed by top.ts before
  // this ever rendered (resolveWatchedRepoSlugs), same as `zz work`'s
  // own agent identity. Switching accounts mid-session changes what
  // `l` shows and what future track/login-gated actions act as, but
  // not the existing watch list; restart `zz top` to pick up a
  // different account's own repos.
  useInput(
    (input) => {
      if (input !== "l" || authBusy) return;
      if (identity) {
        onLogout();
        setIdentity(null);
        return;
      }
      setAuthBusy(true);
      setAuthError(null);
      onLogin()
        .then((username) => {
          setIdentity(username);
          setAuthBusy(false);
        })
        .catch((err) => {
          setAuthBusy(false);
          setAuthError(err instanceof Error ? err.message : String(err));
        });
    },
    { isActive: !exploreEditing && !laneEditing },
  );
  // Explore is always tabs[0] -- reachable the same way regardless of
  // mode -- but which tab actually opens first depends on whether
  // there's anything else worth looking at yet: nothing tracked (the
  // logged-out/no-config empty-dashboard case top.ts can produce) means
  // Explore IS the useful starting point; anything already being
  // watched means lanes is. useState only reads this once (React's own
  // "lazy initial state" semantics), which is exactly right here --
  // watchedRepos growing later (a live "track" from Explore) shouldn't
  // yank the user back to lanes mid-session.
  const [initialTab] = useState(() => (watchedRepos.length === 0 ? 0 : 1));

  useEffect(() => {
    if (!authError) return;
    const id = setTimeout(() => setAuthError(null), 4000);
    return () => clearTimeout(id);
  }, [authError]);

  return (
    <TabView
      title="zz top"
      inputPaused={exploreEditing || laneEditing}
      initialTab={initialTab}
      headerRight={
        <Text>
          <Text color={authError ? YELLOW : identity ? GREEN : MUTED} bold>
            {authError ? "[login failed]" : authBusy ? "[logging in...]" : `[${identity ?? "anon"}]`}
          </Text>
          <Text color={MUTED}> ({identity ? "l: logout" : "l: login"})</Text>
        </Text>
      }
      tabs={[
        { label: "explore", content: () => <Explore local={local} onTrack={onTrack} onEditingChange={setExploreEditing} /> },
        {
          label: "lanes",
          content: (maxRows, scrollOffset) => (
            <LaneList snapshots={snapshots} maxRows={maxRows} scrollOffset={scrollOffset} onPostAsk={onPostAsk} identity={identity} onEditingChange={setLaneEditing} />
          ),
          getFullText: () => laneListText(snapshots),
        },
        { label: "ladder", content: (maxRows, scrollOffset) => <LadderView snapshots={ladders} maxRows={maxRows} scrollOffset={scrollOffset} />, getFullText: () => ladderText(ladders) },
        {
          label: "protocol",
          content: (maxRows, scrollOffset) => <LiveLog events={flattenEvents(snapshots)} watchedRepos={watchedRepos.map((r) => r.slug)} maxRows={maxRows} scrollOffset={scrollOffset} />,
          getFullText: () => liveLogText(flattenEvents(snapshots)),
        },
      ]}
    />
  );
}
