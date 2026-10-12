// A small external store over the set of repos a running `zz work`
// session is watching -- lets a shard discovered mid-session (see
// agent/scriptedWork.ts's runContributorWorkAsk) reach both the TUI
// (via React's useSyncExternalStore) and mainLoop's own polling
// without restarting the process. Deliberately not React-specific
// itself: mainLoop (a plain async function, not a component) reads
// it directly via get(), the TUI subscribes via subscribe()/get().
import type { ResolvedRepo } from "./repo.js";

export interface RepoWatchStore {
  get(): ResolvedRepo[];
  /** No-op if a repo with this slug is already watched -- this is also what makes a shard only ever added once per session, regardless of how many asks reference it. */
  add(repo: ResolvedRepo): void;
  subscribe(listener: () => void): () => void;
}

export function createRepoWatchStore(initial: ResolvedRepo[]): RepoWatchStore {
  let repos = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => repos,
    add(repo) {
      if (repos.some((r) => r.slug === repo.slug)) return;
      repos = [...repos, repo];
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
