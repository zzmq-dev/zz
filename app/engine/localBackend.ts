// Today's behavior, unchanged, behind the Backend interface -- a real
// local clone plus flat/SQLite files under app/state/, exactly as
// before. The only thing that moves is who resolves a repo slug into
// paths: that logic used to live in cli/lib/repo.ts and get threaded
// through every call site by the caller; it lives here now, since a
// path is something only a *local* backend has at all.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Backend } from "./backend.js";
import type { Lane } from "./types.js";
import type { Rung, RungKind } from "./ladder.js";
import type { EmbeddedRung } from "./ladderNotes.js";
import { writeLadder, appendRepoChildren as appendRepoChildrenImpl, readAnchor as readAnchorImpl } from "./ladderNotes.js";
import { listCommitsChronological, commitFileChanges, fileContentAtCommit, type CommitRow, type FileChangeRow } from "./ingest.js";
import { commitChangeset as commitChangesetImpl, type ChangesetFile, type CommitAuthor } from "./changeset.js";
import { readLane as readLaneImpl, writeLane as writeLaneImpl, listLanes as listLanesImpl, withLane as withLaneImpl } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

function parseSlug(slug: string): { name: string } {
  if (typeof slug !== "string" || !slug) {
    throw new Error(`expected a repo slug shaped "owner/repo", got ${JSON.stringify(slug)}.`);
  }
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`expected "owner/repo", got "${slug}"`);
  }
  return { name: parts[1] };
}

function repoDirOf(slug: string): string {
  return join(appRoot, "demo-repos", parseSlug(slug).name);
}

function stateDirOf(slug: string): string {
  return join(appRoot, "state", parseSlug(slug).name);
}

export function createLocalBackend(): Backend {
  return {
    name: "local",

    ensureCloned(repo) {
      const repoDir = repoDirOf(repo);
      if (existsSync(repoDir)) return;
      execFileSync("git", ["clone", "--quiet", `https://github.com/${repo}.git`, repoDir], { stdio: "inherit" });
    },

    listCommits(repo): CommitRow[] {
      return listCommitsChronological(repoDirOf(repo));
    },

    diffCommit(repo, commit): FileChangeRow[] {
      return commitFileChanges(repoDirOf(repo), commit);
    },

    readFileAtCommit(repo, sha, path): string {
      return fileContentAtCommit(repoDirOf(repo), sha, path);
    },

    async commitChangeset(repo, input: { files: ChangesetFile[]; message: string; author: CommitAuthor }): Promise<string> {
      return commitChangesetImpl(repoDirOf(repo), input);
    },

    async readAnchor(repo, path): Promise<EmbeddedRung | null> {
      return readAnchorImpl(repoDirOf(repo), stateDirOf(repo), path);
    },

    async writeLadder(repo, rung: Rung | Rung[]): Promise<void> {
      const rungs = Array.isArray(rung) ? rung : [rung];
      for (const one of rungs) await writeLadder(repoDirOf(repo), stateDirOf(repo), one);
    },

    async appendRepoChildren(repo, children: { path: string; kind: RungKind }[]): Promise<void> {
      await appendRepoChildrenImpl(repoDirOf(repo), stateDirOf(repo), children);
    },

    readLane(repo, laneId): Lane | null {
      return readLaneImpl(stateDirOf(repo), laneId);
    },

    writeLane(repo, lane: Lane): void {
      writeLaneImpl(stateDirOf(repo), lane);
    },

    listLanes(repo): Lane[] {
      return listLanesImpl(stateDirOf(repo));
    },

    withLane(repo, laneId, mutate): Lane {
      return withLaneImpl(stateDirOf(repo), laneId, mutate);
    },
  };
}
