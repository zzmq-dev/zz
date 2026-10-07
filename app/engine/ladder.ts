// The real Ladder shape (see site/content/ladder-design/). The repo's file
// and directory tree is the backbone everything else pivots on:
// repo -> directory -> file -> function -> lines, a containment hierarchy.
//
// Two kinds of rung don't fit that tree:
//   - Repo-level artifacts that aren't shaped like a file (a release, the
//     package itself) hang directly off the repo rung instead of nesting
//     in the directory tree.
//   - Asks are thread-shaped, not containment-shaped: whatever follows an
//     ASK (an ANSWER resolving it, or a further ASK raising something new
//     in the same thread) is a child rung of it, in order. There's no
//     separate "issue" or "comment" concept: a GitHub issue being filed is
//     someone ASKing the Maintainer about something, and a reply is either
//     an ANSWER or another ASK, exactly the same vocabulary native zz
//     activity uses. Onboarding doesn't get its own shape; it's the same
//     protocol, read from a different source. An ask that relates to
//     specific files doesn't contain them; it's referenced as a `source`
//     on those files' own rungs, and separately has its own full rung
//     (with its thread) living at the repo level.
//
// Storage: git notes, one per rung anchored to a real git object (a file's
// blob, a directory's tree, the repo's root tree, the repo's root commit
// for an ask, or the commit a release is tied to), not one blob for the
// whole tree or one file per rung on disk. See engine/ladderNotes.ts and
// engine/gitNotes.ts. This file only defines the authoring shape: build a
// Rung tree with children nested inline, and ladderNotes.ts figures out
// what gets its own note versus what's embedded in its nearest anchor
// ancestor.
export type RungKind =
  | "repo"
  | "directory"
  | "file"
  | "function"
  | "lines"
  | "release"
  | "package"
  | "ask"
  | "answer";

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
  /** Paths of other rungs this one relates to without containing them, e.g. an ask's related files. */
  touches?: string[];
  children: Rung[];
}

/** The repo root rung's path. Not "." since paths double as git note lookup keys and filenames elsewhere. */
export const REPO_RUNG_PATH = "_repo";
