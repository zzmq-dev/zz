// The real Ladder shape (see site/content/ladder-design/): a tree isomorphic
// to the code itself, not to Lane decomposition. One rung per repo,
// directory, file, function, or line range. Each rung can drill down into
// its own history, sourced from real commits/PRs/issues, not invented.
export interface RungSource {
  kind: "commit" | "pr" | "issue";
  ref: string;
  title: string;
  author: string;
  at: string;
}

export interface Rung {
  path: string;
  kind: "repo" | "directory" | "file" | "function" | "lines";
  summary: string;
  sources: RungSource[];
  children: Rung[];
}
