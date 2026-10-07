// Ladder storage via git notes. A note is only worth writing for rungs
// anchored to a real git object (a file's blob, a directory's tree, the
// repo's root tree or root commit, or a release's own commit); a
// function/line/comment rung has no git object of its own, so it's embedded
// inline in its nearest anchor ancestor's note instead of getting one of
// its own. That keeps note count proportional to files + tracked
// issues/releases, not to every function and line, while still letting you
// read "everything about this one file" in a single note.
import type { Rung, RungKind, RungSource } from "./ladder.js";
import { resolvePathSha, resolveRootTreeSha, resolveRootCommit, writeNote, readNote, expandOid } from "./gitNotes.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ANCHOR_KINDS = new Set<RungKind>(["repo", "directory", "file", "issue", "pr", "release"]);

// Issues and PRs don't reliably have a commit to anchor to: plenty are
// closed without a fix (duplicates, won't-fix, feature requests never
// built), so "the commit that closed it" doesn't exist for most of them.
// They're repo-wide instead: anchored to the repo's root commit (a fixed
// point that never changes), with the issue/PR number folded into the note
// ref itself so distinct issues don't collide on that shared anchor, and so
// no separate lookup index is needed either -- path alone tells you the ref.
const REPO_WIDE_KINDS = new Set<RungKind>(["issue", "pr"]);

function notesRef(kind: RungKind, path: string): string {
  if (REPO_WIDE_KINDS.has(kind)) return `refs/notes/zz/ladder/${path}`;
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

function embed(rung: Rung): EmbeddedRung {
  return {
    path: rung.path,
    kind: rung.kind,
    summary: rung.summary,
    sources: rung.sources,
    touches: rung.touches,
    children: rung.children.map((c) => (ANCHOR_KINDS.has(c.kind) ? { ref: c.path } : embed(c))),
  };
}

// Small index, only for releases now: there's no tree path for a release
// and (unlike issues/PRs) it keeps anchoring to its own real commit rather
// than the repo-wide root, so something has to record which commit that
// was. Proportional to how many releases we track, not to codebase size --
// the same reasoning data-format.md gives for keeping Lanes and Roles as
// plain files rather than notes.
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
// than re-walking for every issue/PR rung.
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
  if (REPO_WIDE_KINDS.has(rung.kind)) return cachedRootCommit(repoDir);
  // release: anchor to its own real commit, already in its sources. Our
  // sources store short SHAs for readability; notes need the full one.
  const sha = await expandOid(repoDir, firstCommitRef(rung));
  writeIndexEntry(stateDir, rung.path, sha);
  return sha;
}

/** Writes one note per anchor in the tree, recursively. Non-anchor rungs are embedded, not written separately. */
export async function writeLadder(repoDir: string, stateDir: string, root: Rung): Promise<void> {
  const visit = async (rung: Rung): Promise<void> => {
    if (!ANCHOR_KINDS.has(rung.kind)) return; // shouldn't be called on non-anchors, but guard anyway
    const sha = await anchorSha(repoDir, stateDir, rung);
    await writeNote(repoDir, notesRef(rung.kind, rung.path), sha, embed(rung));
    for (const child of rung.children) {
      if (ANCHOR_KINDS.has(child.kind)) await visit(child);
    }
  };
  await visit(root);
}

/** Reads one anchor's note (its own fields plus everything embedded under it, inline). */
export async function readAnchor(repoDir: string, stateDir: string, path: string): Promise<EmbeddedRung | null> {
  if (path === "_repo") {
    const sha = await resolveRootTreeSha(repoDir);
    return readNote<EmbeddedRung>(repoDir, notesRef("repo", path), sha);
  }
  if (path.startsWith("issues/") || path.startsWith("prs/")) {
    const kind: RungKind = path.startsWith("issues/") ? "issue" : "pr";
    const sha = await cachedRootCommit(repoDir);
    return readNote<EmbeddedRung>(repoDir, notesRef(kind, path), sha);
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
