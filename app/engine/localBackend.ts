// Today's behavior, unchanged, behind the Backend interface -- a real
// local clone plus flat/SQLite files under ~/.zz/, exactly as before.
// Path resolution itself is NOT reimplemented here, despite this
// file's own stated intent once being to own it independently of
// cli/lib/repo.ts (a path is something only a *local* backend has at
// all) -- that second implementation was never kept in sync with the
// real one and drifted to a stale, package-relative "demo-repos/<name>"
// convention cli/lib/repo.ts moved away from during the npm-packaging
// work (see its own header comment: a globally npm-installed copy has
// no business writing a user's real clones into wherever npm put its
// own files). Confirmed live: `zz ladder build` on any repo not
// already pre-seeded under demo-repos/ failed immediately after
// cloning, with an isomorphic-git "Could not find HEAD" -- the clone
// itself landed at the real ~/.zz/repos/<owner>/<name> (cli/lib/repo.ts's
// own ensureCloned), but every Lane/Ladder write from here on tried to
// read it back from the stale, nonexistent demo-repos/<name> path
// instead. One real resolveRepo(), reused, not two that can disagree.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Backend, LadderSearchHit } from "./backend.js";
import type { Lane, RepoPolicy } from "./types.js";
import { DEFAULT_REPO_POLICY, normalizePolicy } from "./policy.js";
import type { Rung, RungKind } from "./ladder.js";
import type { EmbeddedRung } from "./ladderNotes.js";
import { writeLadder, appendRepoChildren as appendRepoChildrenImpl, readAnchor as readAnchorImpl } from "./ladderNotes.js";
import { collectLadder, type ResolvedRung } from "./ladderRender.js";
import { listCommitsChronological, commitFileChanges, fileContentAtCommit, type CommitRow, type FileChangeRow } from "./ingest.js";
import { commitChangeset as commitChangesetImpl, type ChangesetFile, type CommitAuthor } from "./changeset.js";
import { readLane as readLaneImpl, writeLane as writeLaneImpl, listLanes as listLanesImpl, withLane as withLaneImpl } from "./store.js";
import { resolveRepo } from "../cli/lib/repo.js";

/** Every "file"/"repo" kind rung in an already-resolved tree -- same filter as cloudflareBackend.ts's collectSearchableRungs (a changeset/filechange rung is a historical per-commit entry, not a holistic current-state description), just over ResolvedRung (local, children already resolved from notes refs) instead of SimpleRung (remote, embedded inline). */
function collectSearchableRungs(rung: ResolvedRung, out: ResolvedRung[]): void {
  if (rung.kind === "file" || rung.kind === "repo") out.push(rung);
  for (const child of rung.children) collectSearchableRungs(child, out);
}

function repoDirOf(slug: string): string {
  return resolveRepo(slug).repoDir;
}

function stateDirOf(slug: string): string {
  return resolveRepo(slug).stateDir;
}

// A trivial local stand-in for RepoPolicy -- real, RBAC-enforced
// governance only exists remotely (worker/src/repoMeta.ts's own
// zz-meta branch), since a single local user has no one to govern.
// Still a real, persisted value (not just a hardcoded default
// returned on every read): a vote_request about Policy, run entirely
// locally, has somewhere real to land, matching what the demo looks
// like once it's pushed/synced to a real remote repo.
const DEFAULT_LOCAL_POLICY: RepoPolicy = DEFAULT_REPO_POLICY;

function policyPath(stateDir: string): string {
  return join(stateDir, ".zz", "policy.json");
}

function readPolicyFile(stateDir: string): RepoPolicy {
  const path = policyPath(stateDir);
  if (!existsSync(path)) return DEFAULT_LOCAL_POLICY;
  return normalizePolicy(JSON.parse(readFileSync(path, "utf8")));
}

/** Every "owner/repo" slug with a real clone under ~/.zz/repos/ -- the local counterpart to searchLadder's own cross-repo scan, now that a repo's real location is a two-level owner/name tree (cli/lib/repo.ts's own convention) rather than one flat demo-repos/<name> directory. */
function everyLocalRepoSlug(): { slug: string; repoDir: string; stateDir: string }[] {
  const reposRoot = join(homedir(), ".zz", "repos");
  if (!existsSync(reposRoot)) return [];
  const out: { slug: string; repoDir: string; stateDir: string }[] = [];
  for (const ownerEntry of readdirSync(reposRoot, { withFileTypes: true })) {
    if (!ownerEntry.isDirectory()) continue;
    const ownerDir = join(reposRoot, ownerEntry.name);
    for (const repoEntry of readdirSync(ownerDir, { withFileTypes: true })) {
      if (!repoEntry.isDirectory()) continue;
      // The owner segment on disk is already sanitized (resolveRepo's
      // own [^a-zA-Z0-9._-] -> "_" replacement) and lossy -- there's no
      // way back to the real "owner/repo" slug's exact original owner
      // string from the directory name alone. The directory name is
      // used as both halves here, same limitation this function's own
      // caller already documented for the old demo-repos/<name>
      // convention ("not a real owner/repo slug, only the bare name a
      // repo was cloned under").
      out.push({ slug: `${ownerEntry.name}/${repoEntry.name}`, repoDir: join(ownerDir, repoEntry.name), stateDir: join(homedir(), ".zz", "state", ownerEntry.name, repoEntry.name) });
    }
  }
  return out;
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

    // No network cost here to begin with (git notes in a real local
    // clone) -- resolve fresh every call, same as the Ladder tab
    // already did before this method existed, just now reachable
    // through one interface method instead of collectLadder directly.
    async readLadderTree(repo): Promise<ResolvedRung | null> {
      const { tree } = await collectLadder(repoDirOf(repo), stateDirOf(repo));
      return tree;
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
    // every repo currently cloned under ~/.zz/repos/, scanned fresh on
    // every call rather than kept in a maintained index. Not as sharp
    // as the remote backend's BM25 ranking, but the same feature,
    // genuinely working locally -- not a stub.
    async searchLadder(query, limit): Promise<LadderSearchHit[]> {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: LadderSearchHit[] = [];
      for (const { slug, repoDir, stateDir } of everyLocalRepoSlug()) {
        try {
          const { tree } = await collectLadder(repoDir, stateDir);
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
              hits.push({ repo: slug, path: c.path, kind: c.kind, commitSha, summary: c.summary });
            }
          }
        } catch {
          // repo not onboarded/bootstrapped yet -- skip rather than fail the whole search
        }
      }
      return hits.slice(0, limit);
    },

    // No persisted index here to go stale -- searchLadder above scans
    // every repo's CURRENT Ladder tree fresh on every call, so there's
    // nothing to backfill (unlike the remote backend's D1 index,
    // populated incrementally as writes happen).
    async reindexLadder(): Promise<number> {
      return 0;
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

    async readPolicy(repo): Promise<RepoPolicy> {
      return readPolicyFile(stateDirOf(repo));
    },

    async writePolicy(repo, policy): Promise<void> {
      const path = policyPath(stateDirOf(repo));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(policy, null, 2) + "\n");
    },

    // No local equivalent of the remote meta.json's owner/created_at
    // (a single local user has no one else to attribute a repo to) --
    // the root commit's own author/timestamp is the closest honest
    // stand-in, same spirit as DEFAULT_LOCAL_POLICY above.
    async readRepoInfo(repo): Promise<{ owner: string; createdAt: string }> {
      const [root] = listCommitsChronological(repoDirOf(repo));
      if (!root) throw new Error(`${repo}: no commits yet`);
      return { owner: root.author, createdAt: root.at };
    },
  };
}
