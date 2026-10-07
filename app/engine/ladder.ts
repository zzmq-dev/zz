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

export interface Rung {
  path: string;
  kind: RungKind;
  summary: string;
  sources: RungSource[];
  /** Paths of other rungs this one relates to without containing them, e.g. an issue/PR's changed files. */
  touches?: string[];
  /** Structural containment: dir -> file -> function -> lines, or issue/PR -> comments, in order. */
  children: Rung[];
}
