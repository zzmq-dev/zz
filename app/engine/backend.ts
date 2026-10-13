// The one seam between the engine (Lane/Ask/Answer, the Ladder, git
// content) and where it actually lives -- a local clone plus flat
// files today, Cloudflare Artifacts plus a Durable Object once the
// Worker side exists (site/content/remote-backend/index.md). Every
// method takes a repo slug ("owner/repo"), never a resolved local
// path -- that's exactly the thing a backend owns, since a
// CloudflareBackend has no local filesystem path at all. Step 1 of
// that doc's build sequencing: define this, move today's code behind
// LocalBackend with zero behavior change, before anything Cloudflare
// exists.
import type { Lane } from "./types.js";
import type { Rung, RungKind } from "./ladder.js";
import type { EmbeddedRung } from "./ladderNotes.js";
import type { CommitRow, FileChangeRow } from "./ingest.js";
import type { ChangesetFile, CommitAuthor } from "./changeset.js";
import { AsyncLocalStorage } from "node:async_hooks";

export interface LadderSearchHit {
  repo: string;
  path: string;
  kind: RungKind;
  /** The commit this hit's current summary is anchored to, if known -- lets a result link to both the file and the specific commit (webApp.ts's per-commit view). Null if the rung genuinely has no commit source. */
  commitSha: string | null;
  summary: string;
}

export interface Backend {
  readonly name: string;

  // git content -- async on every method, not just the ones that
  // obviously need it: a CloudflareBackend's "read" is a real network
  // call (Artifacts), not a filesystem read, even where LocalBackend's
  // equivalent happens to be synchronous. Matching the interface to
  // the easier (local, sync) case first was a real mistake found only
  // once a genuinely async backend had to implement it for real.
  ensureCloned(repo: string): Promise<void>;
  listCommits(repo: string): Promise<CommitRow[]>;
  diffCommit(repo: string, commit: CommitRow): Promise<FileChangeRow[]>;
  readFileAtCommit(repo: string, sha: string, path: string): Promise<string>;
  /** The only thing that writes code -- a real commit, via isomorphic-git (already Workers-compatible on the local path too). Returns the new commit's oid. */
  commitChangeset(repo: string, input: { files: ChangesetFile[]; message: string; author: CommitAuthor }): Promise<string>;

  // the Ladder (git notes)
  readAnchor(repo: string, path: string): Promise<EmbeddedRung | null>;
  /** A Rung, or several top-level Rungs at once -- the array case used to be handled one level up (engine/lane.ts's mergeLaneLadder); it lives here now so every caller goes through one method. */
  writeLadder(repo: string, rung: Rung | Rung[]): Promise<void>;
  appendRepoChildren(repo: string, children: { path: string; kind: RungKind }[]): Promise<void>;
  /** Full-text search over every repo's Ladder, not just this one -- the cross-repo "ecosystem-wide intelligence" surface (agent/tools.ts's ladder_search). Public repos only (no actor param at this layer to scope private visibility by) -- a real backend-interface method, not an HTTP call from inside a tool's execute(), since that execute() runs server-side (inside the Durable Object) when dispatched through the generic remote tool-calling loop, where there's no filesystem/credentials to make an outbound authenticated call with. */
  searchLadder(query: string, limit: number): Promise<LadderSearchHit[]>;

  // Lane/Ask/Answer
  readLane(repo: string, laneId: string): Promise<Lane | null>;
  writeLane(repo: string, lane: Lane): Promise<void>;
  listLanes(repo: string): Promise<Lane[]>;
  /** Atomic read-modify-write -- the race-free primitive every ask()/answer() mutation goes through. `mutate` itself stays synchronous (it's pure in-memory logic -- RBAC checks, pushing onto history) even though the surrounding read/write now genuinely isn't. */
  withLane(repo: string, laneId: string, mutate: (lane: Lane) => void): Promise<Lane>;
}

let cachedLocal: Backend | null = null;
let localBackendFactory: (() => Backend) | null = null;

// Deliberately NOT a static import of localBackend.ts -- that file
// touches import.meta.url and node:fs at module scope, which crashes
// immediately on load inside workerd (confirmed directly: "Uncaught
// TypeError: ... Received undefined, at fileURLToPath") even though
// the Worker never actually calls into it. cli/zz.ts registers the
// real factory at startup; the Worker/DO never imports that file, so
// localBackend.ts's module body never loads into that bundle at all.
export function registerLocalBackendFactory(factory: () => Backend): void {
  localBackendFactory = factory;
}

// Scopes a Backend to one call stack -- the Worker/Durable Object case
// needs this, not a module-level singleton: a single isolate can host
// multiple DO instances (different repos, different Backend instances
// wrapping different storage), and a plain global would let one
// request's backend leak into another's concurrently-running call.
// Verified directly that AsyncLocalStorage works correctly inside
// workerd for exactly this (two concurrent `als.run` calls, each saw
// only its own value). CLI/local use never touches this -- it falls
// through to the plain lazy singleton below, unchanged.
const backendContext = new AsyncLocalStorage<Backend>();

/** Runs `fn` with `backend` as what resolveBackend() returns for the duration of the call (and anything it awaits) -- how a Worker/DO points engine/lane.ts's calls at its own storage without engine/lane.ts needing to know Cloudflare exists at all. */
export function withBackend<T>(backend: Backend, fn: () => T | Promise<T>): T | Promise<T> {
  return backendContext.run(backend, fn);
}

/** `ZZ_BACKEND=local` (default) or `cloudflare` -- the same pattern as agent/*Backend.ts's model-provider switch, one level down the stack. */
export function resolveBackend(): Backend {
  const scoped = backendContext.getStore();
  if (scoped) return scoped;
  if (cachedLocal) return cachedLocal;
  const which = process.env.ZZ_BACKEND ?? "local";
  if (which === "local") {
    if (!localBackendFactory) throw new Error("resolveBackend(): no local backend registered -- call registerLocalBackendFactory() at startup (cli/zz.ts does this), or use withBackend() to scope a different one.");
    cachedLocal = localBackendFactory();
    return cachedLocal;
  }
  throw new Error(`unknown ZZ_BACKEND "${which}" -- only "local" exists outside of withBackend() so far.`);
}
