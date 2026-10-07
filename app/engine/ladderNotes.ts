// Ladder storage via git notes. A note is only worth writing for rungs
// anchored to a real git object (a file's blob, a directory's tree, the
// repo's root tree or root commit, or a release's own commit); a
// function/line/answer/nested-ask rung has no git object of its own, so
// it's embedded inline in its nearest anchor ancestor's note instead of
// getting one of its own. That keeps note count proportional to files plus
// top-level asks and releases, not to every function, line, and reply,
// while still letting you read "everything about this one file" or "this
// whole ask thread" in a single note.
import type { Rung, RungKind, RungSource } from "./ladder.js";
import { resolvePathSha, resolveRootTreeSha, resolveRootCommit, writeNote, readNote, expandOid } from "./gitNotes.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// repo/directory/file/release are anchors wherever they appear in the tree.
// ask/contributor/dependencies are repo-wide: no tree path, so they anchor
// to the repo's root commit with their own identity folded into the note
// ref instead. "ask" is further special: only a *top-level* ask (a new
// thread) is an anchor. Once you're inside a thread, nothing nested in it
// gets its own note, even an "ask"-kind reply that raises something new in
// that same thread -- it's still part of that one conversation, not a
// fresh top-level item. contributor/dependencies never thread, so they're
// always anchors wherever they appear.
const STRUCTURAL_ANCHOR_KINDS = new Set<RungKind>(["repo", "directory", "file", "release"]);
const REPO_WIDE_ROOT_KINDS = new Set<RungKind>(["ask", "contributor", "dependencies"]);

// Git ref names forbid several characters a real-world path segment can
// easily contain (a bot login like "dependabot[bot]" has brackets). Applied
// consistently on both write and read (both go through this function with
// the same input path), so the mapping stays stable even though it's lossy.
function sanitizeRefSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._/-]/g, "-");
}

function notesRef(kind: RungKind, path: string): string {
  if (REPO_WIDE_ROOT_KINDS.has(kind)) return `refs/notes/zz/ladder/${sanitizeRefSegment(path)}`;
  if (kind === "release") return "refs/notes/zz/ladder/release";
  return "refs/notes/zz/ladder/code";
}

export interface EmbeddedRef {
  ref: string;
}

export interface EmbeddedRung {
  path: string;
  kind: RungKind;
  summary: string;
  sources: RungSource[];
  touches?: string[];
  children: (EmbeddedRung | EmbeddedRef)[];
}

function isRef(x: EmbeddedRung | EmbeddedRef): x is EmbeddedRef {
  return "ref" in x;
}

/** insideThread: true once `rung` itself is inside a thread (is, or descends from, an ask). Its children are then always embedded too, regardless of their own kind -- being a child of any ask means you're part of that one thread, not a fresh top-level item. */
function embed(rung: Rung, insideThread: boolean): EmbeddedRung {
  const childrenInsideThread = insideThread || rung.kind === "ask";
  return {
    path: rung.path,
    kind: rung.kind,
    summary: rung.summary,
    sources: rung.sources,
    touches: rung.touches,
    children: rung.children.map((c) => {
      const isTopLevelRepoWide = !childrenInsideThread && REPO_WIDE_ROOT_KINDS.has(c.kind);
      const isAnchorChild = !childrenInsideThread && STRUCTURAL_ANCHOR_KINDS.has(c.kind);
      if (isTopLevelRepoWide || isAnchorChild) return { ref: c.path };
      return embed(c, childrenInsideThread);
    }),
  };
}

// Small index, only for releases now: there's no tree path for a release
// and (unlike asks) it keeps anchoring to its own real commit rather than
// the repo-wide root, so something has to record which commit that was.
// Proportional to how many releases we track, not to codebase size -- the
// same reasoning data-format.md gives for keeping Lanes and Roles as plain
// files rather than notes.
function indexPath(stateDir: string): string {
  return join(stateDir, ".zz", "ladder-index.json");
}

function readIndex(stateDir: string): Record<string, string> {
  const path = indexPath(stateDir);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeIndexEntry(stateDir: string, rungPath: string, sha: string): void {
  const path = indexPath(stateDir);
  const index = readIndex(stateDir);
  index[rungPath] = sha;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 2) + "\n");
}

function firstCommitRef(rung: Rung): string {
  const commit = rung.sources.find((s) => s.kind === "commit");
  if (!commit) throw new Error(`${rung.path}: no commit source to anchor a note to`);
  return commit.ref;
}

// resolveRootCommit walks the repo's full history; cache it per repo rather
// than re-walking for every top-level ask.
const rootCommitCache = new Map<string, Promise<string>>();
function cachedRootCommit(repoDir: string): Promise<string> {
  let cached = rootCommitCache.get(repoDir);
  if (!cached) {
    cached = resolveRootCommit(repoDir);
    rootCommitCache.set(repoDir, cached);
  }
  return cached;
}

async function anchorSha(repoDir: string, stateDir: string, rung: Rung): Promise<string> {
  if (rung.kind === "repo") return resolveRootTreeSha(repoDir);
  if (rung.kind === "file" || rung.kind === "directory") {
    const sha = await resolvePathSha(repoDir, rung.path);
    if (!sha) throw new Error(`${rung.path}: not found in the repo at HEAD`);
    return sha;
  }
  if (REPO_WIDE_ROOT_KINDS.has(rung.kind)) return cachedRootCommit(repoDir);
  // release: anchor to its own real commit, already in its sources. Our
  // sources store short SHAs for readability; notes need the full one.
  const sha = await expandOid(repoDir, firstCommitRef(rung));
  writeIndexEntry(stateDir, rung.path, sha);
  return sha;
}

/** Writes one note per top-level anchor in the tree, recursively. Everything inside a thread, or nested under a file, is embedded, not written separately. */
export async function writeLadder(repoDir: string, stateDir: string, root: Rung): Promise<void> {
  const visit = async (rung: Rung, insideThread: boolean): Promise<void> => {
    const isAnchor = !insideThread && (REPO_WIDE_ROOT_KINDS.has(rung.kind) || STRUCTURAL_ANCHOR_KINDS.has(rung.kind));
    if (!isAnchor) return; // shouldn't be called on a non-anchor, but guard anyway
    const sha = await anchorSha(repoDir, stateDir, rung);
    await writeNote(repoDir, notesRef(rung.kind, rung.path), sha, embed(rung, false));
    const childrenInsideThread = insideThread || rung.kind === "ask";
    for (const child of rung.children) {
      if (!childrenInsideThread) await visit(child, false);
    }
  };
  await visit(root, false);
}

/**
 * Adds references to the repo root's own note without touching any
 * existing child, written or not. writeLadder always recurses into every
 * anchor child it's given, which is right when building a tree from
 * scratch but would re-derive and overwrite already-correct content for
 * anything passed in as a bare stub just to get it into the children
 * list. This only ever rewrites the repo root's one note.
 */
export async function appendRepoChildren(repoDir: string, stateDir: string, newChildren: { path: string; kind: RungKind }[]): Promise<void> {
  const current = await readAnchor(repoDir, stateDir, "_repo");
  if (!current) throw new Error("repo root has no note yet; run the main build first");
  const existingRefs = new Set(current.children.filter(isRef).map((c) => c.ref));
  const toAdd = newChildren.filter((c) => !existingRefs.has(c.path));
  current.children.push(...toAdd.map((c) => ({ ref: c.path })));
  const sha = await resolveRootTreeSha(repoDir);
  await writeNote(repoDir, notesRef("repo", "_repo"), sha, current);
}

/** Reads one anchor's note (its own fields plus everything embedded under it, inline). */
export async function readAnchor(repoDir: string, stateDir: string, path: string): Promise<EmbeddedRung | null> {
  if (path === "_repo") {
    const sha = await resolveRootTreeSha(repoDir);
    return readNote<EmbeddedRung>(repoDir, notesRef("repo", path), sha);
  }
  if (path.startsWith("asks/")) {
    const sha = await cachedRootCommit(repoDir);
    return readNote<EmbeddedRung>(repoDir, notesRef("ask", path), sha);
  }
  if (path.startsWith("contributors/")) {
    const sha = await cachedRootCommit(repoDir);
    return readNote<EmbeddedRung>(repoDir, notesRef("contributor", path), sha);
  }
  if (path === "dependencies" || path.startsWith("dependencies/") || path === "dependents") {
    const sha = await cachedRootCommit(repoDir);
    return readNote<EmbeddedRung>(repoDir, notesRef("dependencies", path), sha);
  }
  const fileSha = await resolvePathSha(repoDir, path);
  if (fileSha) return readNote<EmbeddedRung>(repoDir, notesRef("file", path), fileSha);
  // Not a tree path: must be a release, looked up in the small index.
  const releaseSha = readIndex(stateDir)[path];
  if (!releaseSha) return null;
  return readNote<EmbeddedRung>(repoDir, notesRef("release", path), releaseSha);
}

/** Finds a rung (anchor or embedded) by exact path, starting from an already-read anchor subtree. */
export function findEmbedded(root: EmbeddedRung, path: string): EmbeddedRung | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    if (isRef(child)) continue;
    const found = findEmbedded(child, path);
    if (found) return found;
  }
  return null;
}

export { isRef };
