// Ladder storage via git notes. A note is only worth writing for rungs
// anchored to a real git object (a file's blob, a directory's tree, the
// repo's root tree, or the commit an issue/release is tied to); a
// function/line/comment rung has no git object of its own, so it's embedded
// inline in its nearest anchor ancestor's note instead of getting one of
// its own. That keeps note count proportional to files + tracked
// issues/releases, not to every function and line, while still letting you
// read "everything about this one file" in a single note.
import type { Rung, RungKind, RungSource } from "./ladder.js";
import { resolvePathSha, resolveRootTreeSha, writeNote, readNote, expandOid } from "./gitNotes.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ANCHOR_KINDS = new Set<RungKind>(["repo", "directory", "file", "issue", "pr", "release"]);

// One namespace per kind that anchors to a commit (issue/pr/release), since
// two unrelated rungs can share the exact same commit (the commit that
// closes an issue is very often also the one a release points at) and a
// single shared ref would let the second write silently clobber the first.
// repo/directory/file all anchor to content-addressed blob/tree SHAs, which
// don't have that problem in practice, so they share one namespace.
function notesRef(kind: RungKind): string {
  switch (kind) {
    case "issue":
      return "refs/notes/zz/ladder/issue";
    case "pr":
      return "refs/notes/zz/ladder/pr";
    case "release":
      return "refs/notes/zz/ladder/release";
    default:
      return "refs/notes/zz/ladder/code";
  }
}

function refForPath(path: string): string {
  if (path.startsWith("issues/")) return notesRef("issue");
  if (path.startsWith("prs/")) return notesRef("pr");
  if (path.startsWith("releases/")) return notesRef("release");
  return notesRef("repo");
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

// Small index for anchors that aren't resolvable from a tree path (issues,
// PRs, releases) -- there's no git object at "issues/651", so we record
// which commit its note is actually attached to. Proportional to how many
// issues/releases we choose to track, not to codebase size, so a plain
// file is fine here; this is exactly the kind of compact, human-browsable
// record data-format.md's ".zz/ not git notes" reasoning is about.
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

async function anchorSha(repoDir: string, stateDir: string, rung: Rung): Promise<string> {
  if (rung.kind === "repo") return resolveRootTreeSha(repoDir);
  if (rung.kind === "file" || rung.kind === "directory") {
    const sha = await resolvePathSha(repoDir, rung.path);
    if (!sha) throw new Error(`${rung.path}: not found in the repo at HEAD`);
    return sha;
  }
  // issue / pr / release: anchor to the real commit already in its sources.
  // Our sources store short SHAs for readability; notes need the full one.
  const sha = await expandOid(repoDir, firstCommitRef(rung));
  writeIndexEntry(stateDir, rung.path, sha);
  return sha;
}

/** Writes one note per anchor in the tree, recursively. Non-anchor rungs are embedded, not written separately. */
export async function writeLadder(repoDir: string, stateDir: string, root: Rung): Promise<void> {
  const visit = async (rung: Rung): Promise<void> => {
    if (!ANCHOR_KINDS.has(rung.kind)) return; // shouldn't be called on non-anchors, but guard anyway
    const sha = await anchorSha(repoDir, stateDir, rung);
    await writeNote(repoDir, notesRef(rung.kind), sha, embed(rung));
    for (const child of rung.children) {
      if (ANCHOR_KINDS.has(child.kind)) await visit(child);
    }
  };
  await visit(root);
}

/** Reads one anchor's note (its own fields plus everything embedded under it, inline). */
export async function readAnchor(repoDir: string, stateDir: string, path: string): Promise<EmbeddedRung | null> {
  let sha: string | null;
  if (path === "_repo") sha = await resolveRootTreeSha(repoDir);
  else {
    sha = await resolvePathSha(repoDir, path);
    if (!sha) sha = readIndex(stateDir)[path] ?? null;
  }
  if (!sha) return null;
  return await readNote<EmbeddedRung>(repoDir, refForPath(path), sha);
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
