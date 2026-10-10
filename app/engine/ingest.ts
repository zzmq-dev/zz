// The ingest/analysis workflow, as named functions, not ad-hoc shell
// exploration run by hand during a conversation. Everything here is
// mechanical data-gathering only (git/gh calls, no model calls) -- the
// actual content analysis happens in the callers (cli/commands/ladder-
// build.ts, cli/commands/ladder-replay-commits.ts) via engine/model.ts.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as git from "isomorphic-git";
import fs from "node:fs";
import type { Rung } from "./ladder.js";

// --- cloning: a real local `git clone`, not isomorphic-git -----------
// This step runs on whoever's machine is doing the onboarding (a CLI user,
// or eventually a Worker fetching from GitHub some other way), not inside
// the Ladder engine itself, so there's no Workers-compatibility reason to
// avoid the real git binary here the way engine/gitNotes.ts does.

export function cloneIfMissing(slug: string, repoDir: string): void {
  if (existsSync(repoDir)) return;
  execFileSync("git", ["clone", "--quiet", `https://github.com/${slug}.git`, repoDir], { stdio: "inherit" });
}

// --- GitHub API access, via the gh CLI --------------------------------
// A CLI-local convenience (shells out, needs `gh` installed and
// authenticated). The real target engine would call the GitHub REST API
// with fetch() and a token instead, which works the same in a Worker; this
// is the one tier of this file that's deliberately not Workers-portable,
// and is called out as such rather than left implicit.

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function ghJsonLines<T>(apiPath: string, jq: string): T[] {
  const raw = gh(["api", apiPath, "--paginate", "--jq", jq]);
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export interface IssueRow {
  number: number;
  title: string;
  state: string;
  user: string;
  created_at: string;
  closed_at: string | null;
  comments: number;
  body: string | null;
}

export function fetchIssues(slug: string): IssueRow[] {
  return ghJsonLines<IssueRow>(
    `repos/${slug}/issues?state=all&per_page=100`,
    ".[] | select(.pull_request == null) | {number, title, state, user: .user.login, created_at, closed_at, comments, body}",
  );
}

export interface PrRow {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  user: string;
  created_at: string;
  closed_at: string | null;
  body: string | null;
}

export function fetchPullRequests(slug: string): PrRow[] {
  return ghJsonLines<PrRow>(`repos/${slug}/pulls?state=all&per_page=100`, ".[] | {number, title, state, merged_at, user: .user.login, created_at, closed_at, body}");
}

export interface CommentRow {
  author: string;
  body: string;
}

/** The comment thread for an issue or PR (GitHub serves both through the same issues/comments endpoint). Zero-cost: no model call, just data. */
export function fetchThreadComments(slug: string, number: number): CommentRow[] {
  return ghJsonLines<CommentRow>(`repos/${slug}/issues/${number}/comments?per_page=100`, ".[] | {author: .user.login, body}");
}

/** A contributor's own commit messages, used to describe what they worked on. Zero-cost: no model call, just data. */
export function fetchContributorCommitMessages(slug: string, login: string): string[] {
  // jq extracts just the first line of each message itself (raw-output,
  // so gh prints it unquoted): a multi-line commit message's embedded
  // newlines would otherwise corrupt the one-line-per-commit split below.
  const raw = gh(["api", `repos/${slug}/commits?author=${encodeURIComponent(login)}&per_page=100`, "--paginate", "--jq", '.[].commit.message | split("\\n")[0]']);
  return raw.trim().split("\n").filter(Boolean);
}

export interface ReleaseRow {
  tag_name: string;
  published_at: string;
  author: string;
  body: string | null;
}

export function fetchReleases(slug: string): ReleaseRow[] {
  return ghJsonLines<ReleaseRow>(`repos/${slug}/releases?per_page=100`, ".[] | {tag_name, published_at, author: .author.login, body}");
}

export interface ContributorRow {
  login: string;
  contributions: number;
}

export function fetchContributors(slug: string): ContributorRow[] {
  return ghJsonLines<ContributorRow>(`repos/${slug}/contributors?per_page=100`, ".[] | {login, contributions}");
}

/**
 * Not implemented: GitHub's dependents graph (network/dependents) has no
 * stable REST/GraphQL endpoint, only the interactive web page. The one
 * real count this project has (supertest: ~1.74M dependent repos) was
 * pulled by hand via a one-off page fetch, not this function, and isn't
 * something a plain script can reproduce unattended. Returns null rather
 * than fabricating a number for a repo this hasn't actually been checked
 * against.
 */
export function fetchDependentsSummary(_slug: string): string | null {
  return null;
}

// --- real commit SHA for a release tag --------------------------------

export function resolveTagCommit(repoDir: string, tag: string): string {
  return execFileSync("git", ["-C", repoDir, "rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
}

// --- dependencies, from package.json -----------------------------------

export interface DependencyRow {
  name: string;
  versionRange: string;
}

export function parseDependencies(repoDir: string): DependencyRow[] {
  const path = join(repoDir, "package.json");
  if (!existsSync(path)) return [];
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const deps: Record<string, string> = pkg.dependencies ?? {};
  return Object.entries(deps).map(([name, versionRange]) => ({ name, versionRange }));
}

export interface UsageSite {
  file: string;
  line: string;
}

/** Where a dependency is actually imported/required in the tracked source. Zero-cost: a grep, no model call. */
export function findDependencyUsage(repoDir: string, name: string): UsageSite[] {
  let raw: string;
  try {
    raw = execFileSync(
      "grep",
      ["-rn", "-F", "--include=*.js", "--include=*.ts", "--include=*.mjs", "--include=*.cjs", "--exclude-dir=node_modules", "--exclude-dir=.git", name, repoDir],
      { encoding: "utf8" },
    );
  } catch {
    return []; // grep exits 1 when there are no matches
  }
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      const [file, , ...rest] = entry.split(":");
      return { file: file.replace(`${repoDir}/`, ""), line: rest.join(":") };
    })
    .filter((site) => /require\(|from\s+['"]/.test(site.line));
}

// --- mechanical file tree: real git log per file, no narrative ---------
// This is the part that didn't exist as code at all before this file --
// every file-level rung before this was hand-written after reading the
// source and its `git log`/`git blame` output directly in conversation,
// not generated by anything re-runnable.

const SKIP_DIR_PARTS = new Set(["node_modules", ".git", "test", "tests", "ci", ".github"]);
const SKIP_EXTENSIONS = new Set([".lock", ".map", ".png", ".jpg", ".svg", ".ico"]);

function shouldSkip(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIR_PARTS.has(p))) return true;
  if ([...SKIP_EXTENSIONS].some((ext) => path.endsWith(ext))) return true;
  if (path === "package-lock.json" || path.endsWith("/package-lock.json")) return true;
  return false;
}

interface FileCommitSummary {
  count: number;
  first: string;
  last: string;
  lastMessage: string;
  lastAuthor: string;
}

async function fileCommitSummary(repoDir: string, filepath: string): Promise<FileCommitSummary> {
  const commits = await git.log({ fs, dir: repoDir, filepath, force: true });
  const dateOf = (c: (typeof commits)[number]) => new Date(c.commit.author.timestamp * 1000).toISOString().slice(0, 10);
  return {
    count: commits.length,
    first: commits.length ? dateOf(commits[commits.length - 1]) : "",
    last: commits.length ? dateOf(commits[0]) : "",
    lastMessage: commits[0]?.commit.message.split("\n")[0] ?? "",
    lastAuthor: commits[0]?.commit.author.name ?? "",
  };
}

async function readFileSafe(absPath: string): Promise<string> {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Called once per file during walkFileTree, with that file's content and
 * the default mechanical (commit-history-only) summary text. Returning
 * the mechanical text unchanged is the zero-cost default; a caller that
 * wants real content analysis does its own work here (e.g. running a
 * Lane through ask/answer and a model call) and returns the result.
 */
export type DescribeFile = (path: string, content: string, mechanical: string) => Promise<string>;

const defaultDescribeFile: DescribeFile = async (_path, _content, mechanical) => mechanical;

/**
 * Walks the tracked file tree at HEAD and builds one file/directory Rung
 * per path, each sourced from that file's commit history (count, date
 * range, most recent commit). Returns only the top-level entries (files
 * and directories directly under the repo root) -- each one's nested
 * children, if it's a directory, are already built in underneath it.
 * No function- or line-level rungs: that split requires actually reading
 * and understanding the code, which stays a by-hand pass.
 */
export async function walkFileTree(repoDir: string, describeFile: DescribeFile = defaultDescribeFile): Promise<Rung[]> {
  const allPaths = await git.listFiles({ fs, dir: repoDir });
  const paths = allPaths.filter((p) => !shouldSkip(p));

  const dirPaths = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i += 1) dirPaths.add(parts.slice(0, i).join("/"));
  }

  const fileRungs = new Map<string, Rung>();
  for (const p of paths) {
    const summary = await fileCommitSummary(repoDir, p);
    const mechanical = `${summary.count} commits, ${summary.first} to ${summary.last}. Last: "${summary.lastMessage}" (${summary.lastAuthor}).`;
    const content = await readFileSafe(join(repoDir, p));
    const described = await describeFile(p, content, mechanical);
    fileRungs.set(p, {
      path: p,
      kind: "file",
      summary: described,
      sources: summary.count ? [{ kind: "commit", ref: "HEAD", title: summary.lastMessage, author: summary.lastAuthor, at: summary.last }] : [],
      children: [],
    });
  }

  const dirRungs = new Map<string, Rung>();
  for (const d of dirPaths) {
    dirRungs.set(d, { path: d, kind: "directory", summary: `Directory. Not individually described.`, sources: [], children: [] });
  }

  // Attach each file/dir to its immediate parent directory's children.
  const roots: Rung[] = [];
  const attach = (path: string, rung: Rung) => {
    const parts = path.split("/");
    if (parts.length === 1) {
      roots.push(rung);
      return;
    }
    const parentPath = parts.slice(0, -1).join("/");
    const parent = dirRungs.get(parentPath);
    if (parent) parent.children.push(rung);
  };
  for (const [p, r] of fileRungs) attach(p, r);
  for (const [p, r] of dirRungs) attach(p, r);

  // Directory summaries are a plain listing of what's in them -- the
  // children are already each individually described, so this just
  // names them rather than describing a directory itself.
  for (const rung of dirRungs.values()) {
    const names = rung.children.map((c) => c.path.split("/").pop()).join(", ");
    rung.summary = `Directory containing ${rung.children.length} entries: ${names}.`;
  }

  return roots;
}

// --- commit-by-commit history, for changeset replay ---------------------
// A different cut through the same repo: not "what does HEAD look like"
// (walkFileTree, above) but "what changed, commit by commit, from the
// root commit forward" -- the raw material for one Lane/changeset per
// commit. Shells out to real git (diff-tree, diff) for the same reason
// cloneIfMissing does: this is a CLI-local convenience step, not part of
// the Workers-bound engine.

export interface CommitRow {
  sha: string;
  parent: string | null; // null for the repo's root commit
  author: string;
  at: string;
  message: string;
}

/** Every commit on the current branch, oldest first -- the order a changeset replay walks them in. Merge commits are walked against their first parent only; a merge's other parents' commits were already visited on their own branch. */
export function listCommitsChronological(repoDir: string): CommitRow[] {
  const sep = "\x1f";
  const raw = execFileSync("git", ["-C", repoDir, "log", "--reverse", "--first-parent", `--format=%H${sep}%P${sep}%an${sep}%aI${sep}%s`], { encoding: "utf8" });
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, author, at, message] = line.split(sep);
      return { sha, parent: parents.split(" ")[0] || null, author, at, message };
    });
}

// The well-known empty-tree object every git repo has; diffing a root
// commit (no parent) against it reports every one of its files as added.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface FileChangeRow {
  path: string;
  status: "added" | "modified" | "deleted";
  /** Unified diff hunks for this file in this commit (empty for added/deleted, where the whole file is the change). */
  hunks: string[];
}

function parseHunks(unifiedDiff: string): string[] {
  const lines = unifiedDiff.split("\n");
  const hunks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) hunks.push(current.join("\n"));
  return hunks;
}

/** What changed in one commit: which files, how, and (for modified files) the actual diff hunks. */
export function commitFileChanges(repoDir: string, commit: CommitRow): FileChangeRow[] {
  const base = commit.parent ?? EMPTY_TREE_SHA;
  const nameStatus = execFileSync("git", ["-C", repoDir, "diff", "--name-status", base, commit.sha], { encoding: "utf8" });
  const rows: FileChangeRow[] = [];
  for (const line of nameStatus.trim().split("\n").filter(Boolean)) {
    const [statusCode, path] = line.split("\t");
    const status = statusCode.startsWith("A") ? "added" : statusCode.startsWith("D") ? "deleted" : "modified";
    let hunks: string[] = [];
    if (status === "modified") {
      const diff = execFileSync("git", ["-C", repoDir, "diff", "--unified=1", base, commit.sha, "--", path], { encoding: "utf8" });
      hunks = parseHunks(diff);
    }
    rows.push({ path, status, hunks });
  }
  return rows;
}

/** A file's full content as of a specific commit -- used to describe a newly-added file without needing a second checkout. */
export function fileContentAtCommit(repoDir: string, sha: string, path: string): string {
  try {
    return execFileSync("git", ["-C", repoDir, "show", `${sha}:${path}`], { encoding: "utf8" });
  } catch {
    return "";
  }
}
