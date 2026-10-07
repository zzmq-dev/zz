// The real Ladder shape (see site/content/ladder-design/). The repo's file
// and directory tree is the backbone everything else pivots on:
// repo -> directory -> file -> function -> lines, a containment hierarchy.
//
// Two kinds of rung don't fit that tree:
//   - Repo-level artifacts that aren't shaped like a file (a release, the
//     package itself) hang directly off the repo rung instead of nesting
//     in the directory tree.
//   - Issues and PRs are thread-shaped, not containment-shaped: a comment
//     is a child rung of its issue/PR, in order. An issue/PR that relates
//     to specific files doesn't contain them; it's referenced as a
//     `source` on those files' own rungs, and separately has its own full
//     rung (with its comment thread) living at the repo level.
//
// Storage: one file per rung, not one blob for the whole tree. A Ladder for
// a real repo is thousands of rungs; a single JSON file would mean every
// read and every write touches the entire thing. Instead each rung is
// addressed by its own path (mirroring the code path it describes,
// "lib/test.js/end/lines-199-267" for a line range inside a function inside
// a file) and `children` on disk is a list of those paths, not embedded
// objects, so reading one rung never requires loading its siblings, let
// alone the whole repo.
export type RungKind =
  | "repo"
  | "directory"
  | "file"
  | "function"
  | "lines"
  | "release"
  | "package"
  | "issue"
  | "pr"
  | "comment";

export interface RungSource {
  kind: "commit" | "pr" | "issue";
  ref: string;
  title: string;
  author: string;
  at: string;
}

/** The on-disk shape: one of these per file under .zz/ladder/. */
export interface StoredRung {
  path: string;
  kind: RungKind;
  summary: string;
  sources: RungSource[];
  /** Paths of other rungs this one relates to without containing them, e.g. an issue/PR's changed files. */
  touches?: string[];
  /** Child rung paths, in order. Dir -> file -> function -> lines, or issue/PR -> comments. */
  children: string[];
}

/** The convenient in-memory shape for authoring: children nested inline instead of by reference. */
export interface Rung {
  path: string;
  kind: RungKind;
  summary: string;
  sources: RungSource[];
  touches?: string[];
  children: Rung[];
}

export const REPO_RUNG_PATH = "_repo";

/** Flattens a nested Rung tree into the StoredRung[] that actually gets written, one per rung. */
export function flatten(rung: Rung): StoredRung[] {
  const out: StoredRung[] = [];
  const visit = (r: Rung) => {
    out.push({
      path: r.path,
      kind: r.kind,
      summary: r.summary,
      sources: r.sources,
      touches: r.touches,
      children: r.children.map((c) => c.path),
    });
    for (const child of r.children) visit(child);
  };
  visit(rung);
  return out;
}
