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
import { createLocalBackend } from "./localBackend.js";

export interface Backend {
  readonly name: string;

  // git content
  ensureCloned(repo: string): void;
  listCommits(repo: string): CommitRow[];
  diffCommit(repo: string, commit: CommitRow): FileChangeRow[];
  readFileAtCommit(repo: string, sha: string, path: string): string;
  /** The only thing that writes code -- a real commit, via isomorphic-git (already Workers-compatible on the local path too). Returns the new commit's oid. */
  commitChangeset(repo: string, input: { files: ChangesetFile[]; message: string; author: CommitAuthor }): Promise<string>;

  // the Ladder (git notes)
  readAnchor(repo: string, path: string): Promise<EmbeddedRung | null>;
  /** A Rung, or several top-level Rungs at once -- the array case used to be handled one level up (engine/lane.ts's mergeLaneLadder); it lives here now so every caller goes through one method. */
  writeLadder(repo: string, rung: Rung | Rung[]): Promise<void>;
  appendRepoChildren(repo: string, children: { path: string; kind: RungKind }[]): Promise<void>;

  // Lane/Ask/Answer
  readLane(repo: string, laneId: string): Lane | null;
  writeLane(repo: string, lane: Lane): void;
  listLanes(repo: string): Lane[];
  /** Atomic read-modify-write -- the race-free primitive every ask()/answer() mutation goes through. */
  withLane(repo: string, laneId: string, mutate: (lane: Lane) => void): Lane;
}

let cached: Backend | null = null;

/** `ZZ_BACKEND=local` (default) or `cloudflare` -- the same pattern as agent/*Backend.ts's model-provider switch, one level down the stack. */
export function resolveBackend(): Backend {
  if (cached) return cached;
  const which = process.env.ZZ_BACKEND ?? "local";
  if (which === "local") {
    cached = createLocalBackend();
    return cached;
  }
  throw new Error(`unknown ZZ_BACKEND "${which}" -- only "local" exists so far (site/content/remote-backend/index.md's CloudflareBackend is the next step).`);
}
