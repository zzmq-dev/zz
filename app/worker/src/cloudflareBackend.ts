// The real Backend (engine/backend.ts) for one Durable Object instance
// -- one DO per repo, folding together the three pieces proven
// separately this session: Lane/Ask/Answer on this DO's own SQLite
// storage, git content (reads native, writes via isomorphic-git's
// minimal-object push) and the Ladder (git notes, via a scoped
// isomorphic-git checkout of just the relevant notes ref) against the
// real Artifacts repo. engine/lane.ts/engine/workqueue.ts never see
// any of this directly -- they only ever call the Backend interface,
// scoped into context via engine/backend.ts's withBackend().
import type { Backend } from "../../engine/backend.js";
import type { Lane } from "../../engine/types.js";
import type { Rung, RungKind } from "../../engine/ladder.js";
import type { EmbeddedRung as RealEmbeddedRung } from "../../engine/ladderNotes.js";
import type { CommitRow, FileChangeRow } from "../../engine/ingest.js";
import type { ChangesetFile, CommitAuthor } from "../../engine/changeset.js";
import { commitChangesetOnArtifacts, headOid, readFileAtCommit as readFileAtCommitImpl, type ArtifactsNamespace, type ArtifactsRepoHandle } from "./cloudflareGitBackend.js";
import { writeRung, readRung, appendRepoChildren as appendRepoChildrenImpl, type SimpleRung } from "./cloudflareLadderBackend.js";
import { indexLadderRung, searchLadderIndex } from "./accountsDb.js";

interface RepoInfo {
  remote: string;
}

async function withRepo<T>(artifacts: ArtifactsNamespace, name: string, fn: (repo: ArtifactsRepoHandle, remote: string) => Promise<T>): Promise<T> {
  const repo = await artifacts.get(name);
  try {
    const info = (await repo.info()) as RepoInfo;
    return await fn(repo, info.remote);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

// Rung's real kind union is wider (directory/release/ask/contributor/
// dependencies/...) than what cloudflareLadderBackend.ts implements
// (repo/file/changeset/filechange, matching what agent/scriptedWork.ts
// actually writes) -- this throws a clear, specific error for any
// other kind rather than silently mishandling it.
function toSimpleRung(rung: Rung): SimpleRung {
  const kind = rung.kind;
  if (kind !== "repo" && kind !== "file" && kind !== "changeset" && kind !== "filechange") {
    throw new Error(`CloudflareBackend: rung kind "${kind}" isn't implemented yet (only repo/file/changeset/filechange are -- see cloudflareLadderBackend.ts's header). Add it there the same way if something now writes it.`);
  }
  return {
    path: rung.path,
    kind,
    summary: rung.summary,
    sources: rung.sources.filter((s) => s.kind === "commit") as SimpleRung["sources"],
    children: rung.children.map(toSimpleRung),
  };
}

/** Every "file"/"repo" kind rung in the tree, in-memory only (a SimpleRung's children are already embedded inline, not a separate fetch per child) -- the set of things worth putting in the cross-repo search index. "changeset"/"filechange" are historical per-commit entries, not current-state descriptions, so they're skipped. */
function collectSearchableRungs(rung: SimpleRung, out: SimpleRung[]): void {
  if (rung.kind === "file" || rung.kind === "repo") out.push(rung);
  for (const child of rung.children) collectSearchableRungs(child, out);
}

export function createCloudflareBackend(storage: DurableObjectStorage, artifacts: ArtifactsNamespace, artifactsName: string, db: D1Database): Backend {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, data TEXT NOT NULL)");

  function readLaneSync(laneId: string): Lane | null {
    const row = sql.exec("SELECT data FROM lanes WHERE id = ?", laneId).toArray()[0] as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Lane) : null;
  }
  function writeLaneSync(lane: Lane): void {
    sql.exec("INSERT OR REPLACE INTO lanes (id, data) VALUES (?, ?)", lane.id, JSON.stringify(lane));
  }

  return {
    name: "cloudflare",

    async ensureCloned(): Promise<void> {
      // No-op: the Artifacts repo is assumed to already exist by the
      // time any DO method runs against it (created once, out of
      // band, the same moment a local repo's first `zz work` call
      // would `ensureCloned` it) -- there's no "local" here to clone
      // into regardless.
    },

    async listCommits(): Promise<CommitRow[]> {
      return withRepo(artifacts, artifactsName, async (repo) => {
        const history = await repo.log({ ref: "main", limit: 1000 });
        // Native log() returns newest-first; engine/ingest.ts's real
        // listCommitsChronological (and everything built on it) expects
        // oldest-first, matching `git log --reverse`.
        return history
          .slice()
          .reverse()
          .map((c) => ({ sha: c.hash, parent: c.parents[0] ?? null, author: c.author?.name ?? "", at: new Date(c.authoredAt * 1000).toISOString(), message: c.message }));
      });
    },

    async diffCommit(_repo, commit: CommitRow): Promise<FileChangeRow[]> {
      // Tree-level diff only (added/modified/deleted) -- no line-level
      // hunks, since there's no `git diff` here, only native tree
      // reads (readCommit/readTree). Not exercised by the live agent
      // loop today (git_diff is a read-only exploration tool); a real
      // limitation flagged rather than silently guessed at if that
      // changes -- line-level hunks would need either a real
      // isomorphic-git diff (a clone) or a hand-rolled line differ,
      // neither built here.
      return withRepo(artifacts, artifactsName, async (repo) => {
        const c = await repo.readCommit(commit.sha);
        if (!c) return [];
        const tree = (await repo.readTree(c.treeHash)) ?? [];
        if (!commit.parent) return tree.map((e) => ({ path: e.name, status: "added" as const, hunks: [] }));
        const parentCommit = await repo.readCommit(commit.parent);
        const parentTree = parentCommit ? (await repo.readTree(parentCommit.treeHash)) ?? [] : [];
        const parentByName = new Map(parentTree.map((e) => [e.name, e]));
        const curByName = new Map(tree.map((e) => [e.name, e]));
        const rows: FileChangeRow[] = [];
        for (const [name, entry] of curByName) {
          const before = parentByName.get(name);
          if (!before) rows.push({ path: name, status: "added", hunks: [] });
          else if (before.hash !== entry.hash) rows.push({ path: name, status: "modified", hunks: [] });
        }
        for (const name of parentByName.keys()) {
          if (!curByName.has(name)) rows.push({ path: name, status: "deleted", hunks: [] });
        }
        return rows;
      });
    },

    async readFileAtCommit(_repo, sha: string, path: string): Promise<string> {
      // "HEAD" is part of the Backend contract, not a real sha --
      // engine/localBackend.ts honors it for free by shelling out to
      // real git (`git show HEAD:path`); the native Artifacts binding
      // only accepts a literal 40-char sha, so resolve it here first
      // (confirmed live: agent/tools.ts's checkNoDroppedExports calls
      // this with sha="HEAD" on every commit_changeset).
      return withRepo(artifacts, artifactsName, async (repo) => readFileAtCommitImpl(repo, sha === "HEAD" ? await headOid(repo) : sha, path));
    },

    async commitChangeset(_repo, input: { files: ChangesetFile[]; message: string; author: CommitAuthor }): Promise<string> {
      return withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("write", 3600);
        return commitChangesetOnArtifacts(artifactsName, remote, token, repo, input);
      });
    },

    async readAnchor(_repo, path: string): Promise<RealEmbeddedRung | null> {
      return withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("read", 3600);
        // "repo" for the root path. A changeset is anchored by commit
        // sha, not a tree path -- readRung's `explicitAnchorSha` param
        // exists for exactly this, but needs a real sha from somewhere.
        // The established path convention (agent/tools.ts's
        // VALID_RUNG_EXAMPLE, cli/commands/work.ts's own comment) is
        // "changesets/<full commit sha>", so the sha is sitting right
        // there in the path itself -- no index file needed, unlike the
        // local backend's stateDir-based one (engine/ladderNotes.ts).
        // Confirmed live: before this, a changeset rung could be
        // written (writeLadder/toSimpleRung handle "changeset" fine)
        // but never read back through this path -- readAnchor always
        // fell through to "file", which tried to resolve the path as a
        // real tree entry and failed ("not found in the repo at HEAD").
        if (path === "_repo") {
          return (await readRung(remote, token, repo, "repo", path)) as RealEmbeddedRung | null;
        }
        if (path.startsWith("changesets/")) {
          const sha = path.slice("changesets/".length);
          return (await readRung(remote, token, repo, "changeset", path, sha)) as RealEmbeddedRung | null;
        }
        return (await readRung(remote, token, repo, "file", path)) as RealEmbeddedRung | null;
      });
    },

    async writeLadder(_repo, rung: Rung | Rung[]): Promise<void> {
      const rungs = (Array.isArray(rung) ? rung : [rung]).map(toSimpleRung);
      await withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("write", 3600);
        for (const one of rungs) await writeRung(remote, token, repo, one);
      });
      // Index after the real write succeeds, not before -- a search
      // hit should never point at content that didn't actually land.
      const searchable: SimpleRung[] = [];
      for (const one of rungs) collectSearchableRungs(one, searchable);
      for (const one of searchable) await indexLadderRung(db, artifactsName, one.path, one.kind, one.summary);
    },

    async appendRepoChildren(_repo, children: { path: string; kind: RungKind }[]): Promise<void> {
      await withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("write", 3600);
        await appendRepoChildrenImpl(remote, token, repo, children);
      });
    },

    async searchLadder(query, limit) {
      const hits = await searchLadderIndex(db, query, limit, null);
      return hits.map((h) => ({ repo: h.repo_slug, path: h.path, kind: h.kind as RungKind, summary: h.summary }));
    },

    async readLane(_repo, laneId: string): Promise<Lane | null> {
      return readLaneSync(laneId);
    },

    async writeLane(_repo, lane: Lane): Promise<void> {
      writeLaneSync(lane);
    },

    async listLanes(): Promise<Lane[]> {
      return sql
        .exec("SELECT data FROM lanes")
        .toArray()
        .map((r) => JSON.parse((r as { data: string }).data) as Lane);
    },

    async withLane(_repo, laneId: string, mutate: (lane: Lane) => void): Promise<Lane> {
      return storage.transactionSync(() => {
        const lane = readLaneSync(laneId);
        if (!lane) throw new Error(`no such lane: ${laneId}`);
        mutate(lane);
        writeLaneSync(lane);
        return lane;
      });
    },
  };
}
