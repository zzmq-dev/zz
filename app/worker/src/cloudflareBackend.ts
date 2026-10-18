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
import { REPO_RUNG_PATH, type Rung, type RungKind } from "../../engine/ladder.js";
import type { EmbeddedRung as RealEmbeddedRung } from "../../engine/ladderNotes.js";
import { resolveLadderTree, type ResolvedRung } from "../../engine/ladderRender.js";
import type { CommitRow, FileChangeRow } from "../../engine/ingest.js";
import type { ChangesetFile, CommitAuthor } from "../../engine/changeset.js";
import { commitChangesetOnArtifacts, headOid, readFileAtCommit as readFileAtCommitImpl, type ArtifactsNamespace, type ArtifactsRepoHandle } from "./cloudflareGitBackend.js";
import { writeRungsBatch, readRung, appendRepoChildren as appendRepoChildrenImpl, rootCommitOid, type SimpleRung, type NotesCache } from "./cloudflareLadderBackend.js";
import { indexLadderRung, searchLadderIndex } from "./accountsDb.js";
import { readRepoMetaAndRoles, writeRepoMeta } from "./repoMeta.js";
import type { RepoPolicy } from "../../engine/types.js";
import { normalizePolicy } from "../../engine/policy.js";

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

// Rung's real kind union is wider than this still -- function/lines/
// answer/package/linechange have no git object of their own and are
// never written as a TOP-LEVEL rung at all (agent/tools.ts's own
// VALID_TOP_LEVEL_KINDS already rejects that before this ever runs);
// they only ever appear embedded inside an anchor's children, which
// this function's own recursive .map(toSimpleRung) call handles
// without needing its own case here.
const IMPLEMENTED_KINDS = new Set<Rung["kind"]>(["repo", "file", "changeset", "filechange", "directory", "release", "ask", "contributor", "dependencies"]);

function toSimpleRung(rung: Rung): SimpleRung {
  const kind = rung.kind;
  if (!IMPLEMENTED_KINDS.has(kind)) {
    throw new Error(`CloudflareBackend: rung kind "${kind}" isn't implemented yet (see cloudflareLadderBackend.ts's header for what is). Add it there the same way if something now writes it.`);
  }
  return {
    path: rung.path,
    kind: kind as SimpleRung["kind"],
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

/** Same filter, over a resolveLadderTree()-resolved tree instead of a SimpleRung -- used by reindexLadder, which walks the Ladder as it reads back (refs followed, not embedded inline the way a fresh write's SimpleRung already is). */
function collectSearchableResolvedRungs(rung: ResolvedRung, out: ResolvedRung[]): void {
  if (rung.kind === "file" || rung.kind === "repo") out.push(rung);
  for (const child of rung.children) collectSearchableResolvedRungs(child, out);
}

export function createCloudflareBackend(storage: DurableObjectStorage, artifacts: ArtifactsNamespace, artifactsName: string, db: D1Database): Backend {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, data TEXT NOT NULL)");

  // A Lane persisted before the Maintainer->Coordinator rename has
  // `maintainers` baked into its stored JSON, not `committee` -- the
  // rename only changed what new code reads and writes, not what's
  // already sitting in storage. Without this, every already-existing
  // Lane would silently come back with `committee: undefined` after
  // this deploy, breaking voting and the review backstop on all of
  // them. Applied at every read path (readLaneSync and listLanes both
  // call this), not just one, since listLanes parses its own rows
  // directly rather than going through readLaneSync.
  function migrateLane(lane: Lane): Lane {
    if (lane.committee === undefined) {
      const legacy = lane as unknown as { maintainers?: string[] };
      lane.committee = legacy.maintainers ?? lane.coordinators;
    }
    return lane;
  }
  function readLaneSync(laneId: string): Lane | null {
    const row = sql.exec("SELECT data FROM lanes WHERE id = ?", laneId).toArray()[0] as { data: string } | undefined;
    return row ? migrateLane(JSON.parse(row.data) as Lane) : null;
  }
  function writeLaneSync(lane: Lane): void {
    sql.exec("INSERT OR REPLACE INTO lanes (id, data) VALUES (?, ?)", lane.id, JSON.stringify(lane));
  }

  // The repo's root (first) commit never changes once a repo has any
  // history -- every later commit only extends the chain forward, so
  // re-deriving it from scratch on every single "_repo" rung read
  // (rootCommitOid's own repo.log(limit:1000) fetch) was pure waste.
  // Confirmed live: this one call was the dominant cost of a repo
  // page's Ladder-tab fetch, well past what the zz-meta branch fetch
  // (webApp.ts's own earlier fix) cost on its own. Cached in this DO's
  // own durable storage, not an in-memory closure -- configure()
  // rebuilds this whole Backend object on every call, so a closure
  // variable would never survive past the request that set it.
  async function cachedRootCommitOid(repo: ArtifactsRepoHandle): Promise<string> {
    const cached = await storage.get<string>("rootCommitOid");
    if (cached) return cached;
    const oid = await rootCommitOid(repo);
    await storage.put("rootCommitOid", oid);
    return oid;
  }

  // Shared across every readAnchorFor call this Backend object
  // handles (i.e. for as long as this DO instance stays configured
  // for this one repo -- see MaintainerDO.configure, which only
  // rebuilds this whole Backend, and so this cache, on an actual repo
  // change). The Ladder tab's getLadderTree (webApp.ts) resolves the
  // "_repo" root's several top-level children (one DO call each) in
  // sequence without re-configuring in between, and several of those
  // children share the exact same underlying notes ref (every
  // file/directory/function/lines rung uses the one "code" ref) --
  // without this, each of those calls re-ran scopedNotesCheckout's
  // real git fetch of that identical ref from scratch. Confirmed live:
  // for a repo with 3 files + 2 changesets at the top level, that was
  // 5 redundant checkouts instead of 2.
  const notesCache: NotesCache = new Map();

  // The WHOLE resolved tree, cached durably and kept up to date on
  // every write (writeLadder below, via mergeRungsIntoLadderTreeCache)
  // -- not time-based, so a repo nobody's touching stays servable from
  // cache indefinitely. Durable storage, not an in-memory field, so it
  // survives this DO instance being evicted and cold-starting later --
  // the in-memory notesCache above only needs to survive one burst of
  // calls (it's just dedup within a resolve), but this is the actual
  // "don't make a user wait on N real git-notes fetches to see an
  // unchanged Ladder tab" fix, so it should outlive the JS instance,
  // not just one request. Direct instruction: "cache at every level
  // and invalidate cache only on ladder updates so that it can be
  // warmed" -- this is that cache, updated (not merely invalidated)
  // on every update so it's never left cold right when it matters
  // most: a brand-new write's own notes aren't reliably readable back
  // from Artifacts for a while after (readRung's doc comment has the
  // full story) -- updating the cache directly from the rungs already
  // in hand sidesteps that gap instead of racing it.
  const LADDER_TREE_CACHE_KEY = "resolvedLadderTree";

  function simpleToResolved(rung: SimpleRung): ResolvedRung {
    return { path: rung.path, kind: rung.kind, summary: rung.summary, sources: rung.sources, children: rung.children.map(simpleToResolved) };
  }

  // Builds/updates the cached tree directly from the rungs just
  // written -- no re-read from Artifacts at all, so this can't be
  // caught by the same-ref read-after-write gap readRung's doc
  // comment describes (confirmed live: even re-resolving through the
  // SAME repo handle/token the write itself just used still couldn't
  // see a brand-new ref moments after creating it). A "_repo" write
  // only replaces root's own fields and keeps whatever children the
  // cache already had -- a root rung's own `children` is always []
  // from the caller (engine/lane.ts's mergeLaneLadder writes _repo's
  // real children via the separate appendRepoChildren call), so
  // overwriting children here would just erase them. A non-root rung
  // is upserted directly as a child of root: that's also exactly
  // where appendRepoChildren would otherwise be linking it, and
  // mergeLaneLadder always calls writeLadder then appendRepoChildren
  // with the very same rungs in the same merge -- doing it here makes
  // appendRepoChildren's own cache step unnecessary for that one real
  // call pattern, so it's left alone instead of risking an
  // Artifacts-read-based refresh clobbering a cache this already got
  // right.
  async function mergeRungsIntoLadderTreeCache(rungs: SimpleRung[]): Promise<void> {
    let tree = (await storage.get<ResolvedRung>(LADDER_TREE_CACHE_KEY)) ?? null;
    for (const rung of rungs) {
      if (rung.path === REPO_RUNG_PATH) {
        tree = tree ? { ...simpleToResolved(rung), children: tree.children } : simpleToResolved(rung);
        continue;
      }
      // No root to attach to yet, and this write isn't the root
      // either -- leave the cache alone; a later real read recomputes
      // from Artifacts the old way rather than caching a rootless tree.
      if (!tree) continue;
      const node = simpleToResolved(rung);
      const idx = tree.children.findIndex((c) => c.path === rung.path);
      tree = idx >= 0 ? { ...tree, children: tree.children.map((c, i) => (i === idx ? node : c)) } : { ...tree, children: [...tree.children, node] };
    }
    if (tree) await storage.put(LADDER_TREE_CACHE_KEY, tree);
  }

  // Extracted out of the `readAnchor` method itself so reindexLadder
  // (below) can drive the same path-resolution logic through
  // resolveLadderTree without going through `this` -- a plain closure,
  // not a bound method, so it stays correct regardless of how this
  // Backend object gets passed around.
  async function readAnchorFor(path: string): Promise<RealEmbeddedRung | null> {
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
        return (await readRung(remote, token, repo, "repo", path, await cachedRootCommitOid(repo), notesCache)) as RealEmbeddedRung | null;
      }
      if (path.startsWith("changesets/")) {
        const sha = path.slice("changesets/".length);
        return (await readRung(remote, token, repo, "changeset", path, sha, notesCache)) as RealEmbeddedRung | null;
      }
      // "directory" rungs have no path-prefix convention of their own
      // (same as the local backend, engine/ladderNotes.ts's own
      // readAnchor, which doesn't handle them either) -- they're only
      // ever read as embedded children of their parent's own rung via
      // a whole-tree walk (resolveLadderTree), never by a standalone
      // point lookup, so there's nothing to route here.
      if (path.startsWith("asks/")) {
        return (await readRung(remote, token, repo, "ask", path, await cachedRootCommitOid(repo), notesCache)) as RealEmbeddedRung | null;
      }
      if (path.startsWith("contributors/")) {
        return (await readRung(remote, token, repo, "contributor", path, await cachedRootCommitOid(repo), notesCache)) as RealEmbeddedRung | null;
      }
      if (path === "dependencies" || path.startsWith("dependencies/") || path === "dependents") {
        return (await readRung(remote, token, repo, "dependencies", path, await cachedRootCommitOid(repo), notesCache)) as RealEmbeddedRung | null;
      }
      // Root-anchored, not index-resolved-to-the-tag's-own-commit the
      // way the local backend does it (engine/ladderNotes.ts's own
      // readIndex lookup) -- there's no stateDir/index file remotely,
      // and cloudflareLadderBackend.ts's own writeRung already made
      // this same simplification on the write side (see
      // ROOT_ANCHORED_KINDS's comment there). The real commit a
      // release maps to still lives in the rung's own `sources`.
      if (path.startsWith("releases/")) {
        return (await readRung(remote, token, repo, "release", path, await cachedRootCommitOid(repo), notesCache)) as RealEmbeddedRung | null;
      }
      return (await readRung(remote, token, repo, "file", path, undefined, notesCache)) as RealEmbeddedRung | null;
    });
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
      return readAnchorFor(path);
    },

    // The one real fix for "the Ladder tab/zz top is slow" -- see
    // engine/backend.ts's own doc comment on this method for why a
    // Cloudflare-backed repo needs this where LocalBackend doesn't.
    // Cache-first: a cache hit is one durable-storage read, no
    // Artifacts/git calls at all, regardless of how many rungs the
    // real tree has.
    async readLadderTree(): Promise<ResolvedRung | null> {
      const cached = await storage.get<ResolvedRung>(LADDER_TREE_CACHE_KEY);
      if (cached) return cached;
      const { tree } = await resolveLadderTree(readAnchorFor);
      await storage.put(LADDER_TREE_CACHE_KEY, tree);
      return tree;
    },

    async writeLadder(_repo, rung: Rung | Rung[]): Promise<void> {
      const rungs = (Array.isArray(rung) ? rung : [rung]).map(toSimpleRung);
      await withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("write", 3600);
        await writeRungsBatch(remote, token, repo, rungs);
      });
      // Built directly from the rungs just written -- see
      // mergeRungsIntoLadderTreeCache's doc comment for why this
      // doesn't re-read from Artifacts to do it.
      await mergeRungsIntoLadderTreeCache(rungs);
      // Index after the real write succeeds, not before -- a search
      // hit should never point at content that didn't actually land.
      const searchable: SimpleRung[] = [];
      for (const one of rungs) collectSearchableRungs(one, searchable);
      for (const one of searchable) {
        // The most recent commit source, not the first -- sources
        // accumulates chronologically as a file gets touched again, and
        // a search result's commit link should point at what most
        // recently shaped this summary, not its very first appearance.
        const commitSha = one.sources.length ? one.sources[one.sources.length - 1].ref : null;
        await indexLadderRung(db, artifactsName, one.path, one.kind, one.summary, commitSha);
      }
    },

    async appendRepoChildren(_repo, children: { path: string; kind: RungKind }[]): Promise<void> {
      await withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("write", 3600);
        await appendRepoChildrenImpl(remote, token, repo, children);
      });
      // No cache update needed here: the one real caller
      // (engine/lane.ts's mergeLaneLadder) always calls writeLadder
      // with these exact same rungs immediately before this, and that
      // call's own mergeRungsIntoLadderTreeCache already added them
      // as children of root -- this call is just linking the same
      // refs on the Artifacts side. If that stops being true for some
      // future caller, this would need its own merge or an
      // invalidateLadderTreeCache() fallback; not needed today.
    },

    async searchLadder(query, limit) {
      const hits = await searchLadderIndex(db, query, limit, null);
      return hits.map((h) => ({ repo: h.repo_slug, path: h.path, kind: h.kind as RungKind, commitSha: h.commit_sha, summary: h.summary }));
    },

    // Backfill: searchLadder only ever sees what's been written SINCE
    // the index existed (confirmed live: a repo with real "tie"/"untie"
    // content in a file rung written before this feature shipped was
    // invisible to search -- only a repo's newest written rung showed
    // up). Walks the repo's current tree the same way the read path
    // does (resolveLadderTree + this backend's own anchor resolution,
    // following every ref) rather than trusting whatever's already
    // embedded in one note, so a rung that's only reachable via a ref
    // chain still gets (re)indexed correctly.
    async reindexLadder(): Promise<number> {
      const { tree } = await resolveLadderTree(readAnchorFor);
      const searchable: ResolvedRung[] = [];
      collectSearchableResolvedRungs(tree, searchable);
      for (const one of searchable) {
        const commitSources = one.sources.filter((s) => s.kind === "commit");
        const commitSha = commitSources.length ? commitSources[commitSources.length - 1].ref : null;
        await indexLadderRung(db, artifactsName, one.path, one.kind, one.summary, commitSha);
      }
      return searchable.length;
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
        .map((r) => migrateLane(JSON.parse((r as { data: string }).data) as Lane));
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

    async readPolicy(): Promise<RepoPolicy> {
      return withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("read", 3600);
        const { meta } = await readRepoMetaAndRoles(remote, token);
        if (!meta) throw new Error(`${artifactsName}: repo has no metadata yet`);
        return normalizePolicy(meta.policy);
      });
    },

    async writePolicy(_repo, policy: RepoPolicy): Promise<void> {
      await withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("write", 3600);
        const { meta } = await readRepoMetaAndRoles(remote, token);
        if (!meta) throw new Error(`${artifactsName}: repo has no metadata yet`);
        await writeRepoMeta(remote, token, { ...meta, policy });
      });
    },

    async readRepoInfo(): Promise<{ owner: string; createdAt: string }> {
      return withRepo(artifacts, artifactsName, async (repo, remote) => {
        const token = await repo.createToken("read", 3600);
        const { meta } = await readRepoMetaAndRoles(remote, token);
        if (!meta) throw new Error(`${artifactsName}: repo has no metadata yet`);
        return { owner: meta.owner, createdAt: meta.created_at };
      });
    },
  };
}
