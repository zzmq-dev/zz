// A deliberately MINIMAL Backend (engine/backend.ts) for `zz work`
// operating against a deployed Worker's real protocol state --
// read-only. Every mutation (ask_claim, ask_post, ask_answer,
// commit_changeset, ladder_write_rung, lane_propose) goes through
// callRemoteTool directly instead of through this Backend's write
// methods, because the server's real atomicity (MaintainerDO's
// storage.transactionSync-backed withLane) only exists server-side --
// a client-side read-modify-write here would race against other
// agents working the same repo concurrently, exactly the failure mode
// this whole project exists to prevent. Reads are safe either way, so
// this Backend only implements those; its write methods throw loudly
// rather than silently doing something non-atomic, so any new code
// path that tries to use one fails fast instead of corrupting state
// under real concurrency.
//
// Not constructed per-repo: every Backend method already takes `repo`
// as its own first argument (claimableAcrossRepos iterates several
// repos through the SAME Backend instance), so this just forwards
// whichever repo each call names, rather than baking one in.
import type { Backend, LadderSearchHit } from "../../engine/backend.js";
import type { Lane } from "../../engine/types.js";
import type { EmbeddedRung } from "../../engine/ladderNotes.js";
import type { ResolvedRung } from "../../engine/ladderRender.js";
import { callRemoteTool } from "./remoteTools.js";
import { apiFetch } from "./api.js";

function notSupported(method: string): never {
  throw new Error(
    `RemoteBackend.${method}: not implemented on purpose -- mutations go through callRemoteTool (the real protocol tools: ask_post/ask_claim/ask_answer/commit_changeset/ladder_write_rung/lane_propose), never a raw Backend write, since only the server side can make a Lane mutation atomic against other concurrently-working agents.`,
  );
}

export const remoteBackend: Backend = {
  name: "remote",
  async ensureCloned() {
    // No-op here -- cli/lib/repo.ts's own mode-aware ensureCloned
    // handles getting a real local working copy (via the git smart-
    // HTTP proxy) for run_in_sandbox/threeWayMerge to use; this
    // Backend is only the Lane/Ladder/git-content read surface.
  },
  listCommits: () => notSupported("listCommits"),
  diffCommit: () => notSupported("diffCommit"),
  async readFileAtCommit(repo, sha, path) {
    return (await callRemoteTool(repo, "git_show_file", { sha, path })) as string;
  },
  commitChangeset: () => notSupported("commitChangeset"),
  async readAnchor(repo, path) {
    return (await callRemoteTool(repo, "ladder_read", { path })) as EmbeddedRung | null;
  },
  // One tool call, server-side resolved and cached -- NOT the client-
  // side resolveLadderTree(readAnchor) walk this repo used to drive
  // (tui/useLadderTrees.ts), which meant one real HTTP round trip per
  // rung. Confirmed live: that was the actual cause of `zz top`'s
  // Ladder tab being unusably slow, and would only get worse on a
  // repo with many files/changesets -- this collapses it to one call
  // regardless of tree size, server-side cached so repeat polls of an
  // unchanged tree are nearly free.
  async readLadderTree(repo) {
    return (await callRemoteTool(repo, "ladder_tree", {})) as ResolvedRung | null;
  },
  writeLadder: () => notSupported("writeLadder"),
  appendRepoChildren: () => notSupported("appendRepoChildren"),
  async readLane(repo, laneId) {
    return (await callRemoteTool(repo, "lane_get", { lane_id: laneId })) as Lane | null;
  },
  writeLane: () => notSupported("writeLane"),
  async listLanes(repo) {
    return (await callRemoteTool(repo, "lane_list", {})) as Lane[];
  },
  withLane: () => notSupported("withLane"),
  // Cross-repo, so callRemoteTool (which routes to one specific
  // repo's DO) doesn't apply here -- a direct API call instead, same
  // as any other plain CLI->Worker call. Safe specifically because
  // this file (cli/lib/remoteBackend.ts) only ever runs in the CLI's
  // own process, never bundled into the Worker -- unlike
  // agent/tools.ts's ladder_search tool, whose execute() runs
  // server-side when dispatched through the generic remote
  // tool-calling loop and so can't make this same kind of call.
  async searchLadder(query, limit) {
    const { hits } = await apiFetch<{ hits: { repo_slug: string; path: string; kind: string; commit_sha: string | null; summary: string }[] }>("GET", `/api/ladder/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return hits.map((h) => ({ repo: h.repo_slug, path: h.path, kind: h.kind as LadderSearchHit["kind"], commitSha: h.commit_sha, summary: h.summary }));
  },
  // Repo-scoped (unlike searchLadder), so callRemoteTool applies here --
  // routes to that one repo's DO, same as any other mutation-shaped call.
  async reindexLadder(repo) {
    const { indexed } = (await callRemoteTool(repo, "ladder_reindex", { repo })) as { indexed: number };
    return indexed;
  },
};
