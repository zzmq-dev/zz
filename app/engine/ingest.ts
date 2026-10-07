// The real ingest/analysis workflow, as actual functions, not ad-hoc shell
// exploration. Everything that previously happened as one-off `git log`/
// `git blame`/`gh api` calls run by hand while researching a rung's real
// content now has a named function here, callable the same way for any
// repo, not just the one it was first written against.
//
// Two tiers, both honest about which they are:
//   - Mechanical (this file): real data, lightly transformed, no narrative
//     research. Runs unattended for any repo. This is what a `zz ladder
//     build` actually automates today.
//   - Deep research (not here): reading a file and genuinely understanding
//     what a function does, or reading a real comment thread and judging
//     which replies are asks versus answers, the way asks/798 and asks/651
//     got built. That's not mechanical, and nothing in this file claims to
//     automate it; it stays a by-hand pass until there's a real
//     summarization model wired in (see ladder-design.md's open questions).
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
}

export function fetchIssues(slug: string): IssueRow[] {
  return ghJsonLines<IssueRow>(
    `repos/${slug}/issues?state=all&per_page=100`,
    ".[] | select(.pull_request == null) | {number, title, state, user: .user.login, created_at, closed_at, comments}",
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
}

export function fetchPullRequests(slug: string): PrRow[] {
  return ghJsonLines<PrRow>(`repos/${slug}/pulls?state=all&per_page=100`, ".[] | {number, title, state, merged_at, user: .user.login, created_at, closed_at}");
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

/**
 * Walks the real tracked file tree at HEAD and builds one lightweight
 * file/directory Rung per real path, each sourced from that file's real
 * commit history (count, date range, most recent real commit). No
 * function- or line-level rungs: that split requires actually reading and
 * understanding the code, which stays a by-hand pass (see the file header).
 */
export async function walkFileTree(repoDir: string): Promise<Rung[]> {
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
    fileRungs.set(p, {
      path: p,
      kind: "file",
      summary: `${summary.count} real commits, ${summary.first} to ${summary.last}. Last: "${summary.lastMessage}" (${summary.lastAuthor}). Not read in depth; no function- or line-level rungs yet.`,
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

  return roots;
}
