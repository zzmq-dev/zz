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
import type { Backend } from "../../engine/backend.js";
import type { Lane } from "../../engine/types.js";
import type { EmbeddedRung } from "../../engine/ladderNotes.js";
import { callRemoteTool } from "./remoteTools.js";

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
};
