// Today's behavior, unchanged, behind the Backend interface -- a real
// local clone plus flat/SQLite files under app/state/, exactly as
// before. The only thing that moves is who resolves a repo slug into
// paths: that logic used to live in cli/lib/repo.ts and get threaded
// through every call site by the caller; it lives here now, since a
// path is something only a *local* backend has at all.
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Backend, LadderSearchHit } from "./backend.js";
import type { Lane } from "./types.js";
import type { Rung, RungKind } from "./ladder.js";
import type { EmbeddedRung } from "./ladderNotes.js";
import { writeLadder, appendRepoChildren as appendRepoChildrenImpl, readAnchor as readAnchorImpl } from "./ladderNotes.js";
import { collectLadder, type ResolvedRung } from "./ladderRender.js";
import { listCommitsChronological, commitFileChanges, fileContentAtCommit, type CommitRow, type FileChangeRow } from "./ingest.js";
import { commitChangeset as commitChangesetImpl, type ChangesetFile, type CommitAuthor } from "./changeset.js";
import { readLane as readLaneImpl, writeLane as writeLaneImpl, listLanes as listLanesImpl, withLane as withLaneImpl } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

/** Every "file"/"repo" kind rung in an already-resolved tree -- same filter as cloudflareBackend.ts's collectSearchableRungs (a changeset/filechange rung is a historical per-commit entry, not a holistic current-state description), just over ResolvedRung (local, children already resolved from notes refs) instead of SimpleRung (remote, embedded inline). */
function collectSearchableRungs(rung: ResolvedRung, out: ResolvedRung[]): void {
  if (rung.kind === "file" || rung.kind === "repo") out.push(rung);
  for (const child of rung.children) collectSearchableRungs(child, out);
}

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

    async ensureCloned(repo) {
      const repoDir = repoDirOf(repo);
      if (existsSync(repoDir)) return;
      execFileSync("git", ["clone", "--quiet", `https://github.com/${repo}.git`, repoDir], { stdio: "inherit" });
    },

    async listCommits(repo): Promise<CommitRow[]> {
      return listCommitsChronological(repoDirOf(repo));
    },

    async diffCommit(repo, commit): Promise<FileChangeRow[]> {
      return commitFileChanges(repoDirOf(repo), commit);
    },

    async readFileAtCommit(repo, sha, path): Promise<string> {
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

    // No D1/FTS5 here -- a plain multi-term substring match (every
    // query word must appear in the summary, case-insensitive) over
    // every repo currently cloned under demo-repos/, scanned fresh on
    // every call rather than kept in a maintained index. Not as sharp
    // as the remote backend's BM25 ranking, but the same feature,
    // genuinely working locally -- not a stub. "repo" in each hit is
    // just the directory name (demo-repos/<name>), not a real
    // "owner/repo" slug: local mode has no account/ownership concept
    // to reconstruct one from, only ever the bare name a repo was
    // cloned under.
    async searchLadder(query, limit): Promise<LadderSearchHit[]> {
      const demoReposDir = join(appRoot, "demo-repos");
      if (!existsSync(demoReposDir)) return [];
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: LadderSearchHit[] = [];
      for (const entry of readdirSync(demoReposDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const { tree } = await collectLadder(join(demoReposDir, entry.name), join(appRoot, "state", entry.name));
          const candidates: ResolvedRung[] = [];
          collectSearchableRungs(tree, candidates);
          for (const c of candidates) {
            const haystack = c.summary.toLowerCase();
            if (terms.every((t) => haystack.includes(t))) {
              // Unlike cloudflareLadderBackend.ts's SimpleRung (already
              // commit-only by construction), a local ResolvedRung's
              // sources can include pr/issue kinds too -- filter before
              // taking the most recent one.
              const commitSources = c.sources.filter((s) => s.kind === "commit");
              const commitSha = commitSources.length ? commitSources[commitSources.length - 1].ref : null;
              hits.push({ repo: entry.name, path: c.path, kind: c.kind, commitSha, summary: c.summary });
            }
          }
        } catch {
          // repo not onboarded/bootstrapped yet -- skip rather than fail the whole search
        }
      }
      return hits.slice(0, limit);
    },

    async readLane(repo, laneId): Promise<Lane | null> {
      return readLaneImpl(stateDirOf(repo), laneId);
    },

    async writeLane(repo, lane: Lane): Promise<void> {
      writeLaneImpl(stateDirOf(repo), lane);
    },

    async listLanes(repo): Promise<Lane[]> {
      return listLanesImpl(stateDirOf(repo));
    },

    async withLane(repo, laneId, mutate): Promise<Lane> {
      return withLaneImpl(stateDirOf(repo), laneId, mutate);
    },
  };
}
