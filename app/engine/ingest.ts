// The ingest/analysis workflow, as named functions, not ad-hoc shell
// exploration run by hand during a conversation. Every rung this builds
// -- files, asks, contributors, dependencies -- gets its content read and
// summarized by engine/summarize.ts, not left as a metadata-only stub.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as git from "isomorphic-git";
import fs from "node:fs";
import type { Rung } from "./ladder.js";
import { createLimiter, summarizeFile } from "./summarize.js";

// --- cloning: a plain `git clone`, not isomorphic-git -----------------
// This step runs on whoever's machine is doing the onboarding (a CLI user,
// or eventually a Worker fetching from GitHub some other way), not inside
// the Ladder engine itself, so there's no Workers-compatibility reason to
// avoid the git binary here the way engine/gitNotes.ts does.

export function cloneIfMissing(slug: string, repoDir: string): void {
  if (existsSync(repoDir)) return;
  execFileSync("git", ["clone", "--quiet", `https://github.com/${slug}.git`, repoDir], { stdio: "inherit" });
}

// --- GitHub API access, via the gh CLI --------------------------------
// A CLI-local convenience (shells out, needs `gh` installed and
// authenticated). The target engine would call the GitHub REST API with
// fetch() and a token instead, which works the same in a Worker; this is
// the one tier of this file that's deliberately not Workers-portable,
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

/** The comment thread for an issue or PR (GitHub serves both through the same issues/comments endpoint). */
export function fetchThreadComments(slug: string, number: number): CommentRow[] {
  return ghJsonLines<CommentRow>(`repos/${slug}/issues/${number}/comments?per_page=100`, ".[] | {author: .user.login, body}");
}

/** A contributor's own commit messages, used to describe what they worked on. */
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
 * count this project has (supertest: ~1.74M dependent repos) was pulled by
 * hand via a one-off page fetch, not this function, and isn't something a
 * plain script can reproduce unattended. Returns null rather than
 * fabricating a number for a repo this hasn't been checked against.
 */
export function fetchDependentsSummary(_slug: string): string | null {
  return null;
}

// --- commit SHA for a release tag --------------------------------------

export function resolveTagCommit(repoDir: string, tag: string): string {
  return execFileSync("git", ["-C", repoDir, "rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
}

// --- dependencies, from package.json, plus their actual usage sites ----

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

/** Where a dependency is actually imported/required in the tracked source, for summarizeDependencyUsage to read. */
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

// --- file tree: commit history plus an actual per-file summary ---------
// Every file-level rung is backed by its own commit history AND a summary
// of its content (engine/summarize.ts reads the file and describes it),
// not a stand-in that says the content wasn't read.

const SKIP_DIR_PARTS = new Set(["node_modules", ".git", "test", "tests", "ci", ".github"]);
const SKIP_EXTENSIONS = new Set([".lock", ".map", ".png", ".jpg", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".gif", ".webp", ".pdf", ".zip"]);

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
 * Walks the tracked file tree at HEAD and builds one file/directory Rung
 * per path: commit history from git, plus a content summary from
 * engine/summarize.ts. No function- or line-level rungs yet -- that split
 * is a finer-grained pass on top of this, not implemented here.
 */
export async function walkFileTree(repoDir: string, onProgress?: (done: number, total: number) => void): Promise<Rung[]> {
  const allPaths = await git.listFiles({ fs, dir: repoDir });
  const paths = allPaths.filter((p) => !shouldSkip(p));

  const dirPaths = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i += 1) dirPaths.add(parts.slice(0, i).join("/"));
  }

  const limit = createLimiter(5);
  let done = 0;
  const fileRungs = new Map<string, Rung>();
  await Promise.all(
    paths.map((p) =>
      limit(async () => {
        const [commitSummary, content] = await Promise.all([
          fileCommitSummary(repoDir, p),
          readFileSafe(join(repoDir, p)),
        ]);
        const contentSummary = content === null ? "Binary or unreadable as text; not summarized." : await summarizeFile(p, content);
        fileRungs.set(p, {
          path: p,
          kind: "file",
          summary: contentSummary,
          sources: commitSummary.count
            ? [{ kind: "commit", ref: "HEAD", title: commitSummary.lastMessage, author: commitSummary.lastAuthor, at: commitSummary.last }]
            : [],
          children: [],
        });
        done += 1;
        onProgress?.(done, paths.length);
      }),
    ),
  );

  const dirRungs = new Map<string, Rung>();
  for (const d of dirPaths) {
    dirRungs.set(d, { path: d, kind: "directory", summary: "", sources: [], children: [] });
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

  // Directory summaries are a plain listing of what's actually in them --
  // the children are already each individually summarized, so this just
  // names them rather than running a second LLM pass per directory.
  for (const rung of dirRungs.values()) {
    const names = rung.children.map((c) => c.path.split("/").pop()).join(", ");
    rung.summary = `Directory containing ${rung.children.length} entries: ${names}.`;
  }

  return roots;
}

async function readFileSafe(absPath: string): Promise<string | null> {
  try {
    const content = readFileSync(absPath, "utf8");
    // A decoded buffer containing the replacement character or NUL bytes
    // is almost always binary content, not real UTF-8 text.
    if (content.includes("�") || content.includes("\u0000")) return null;
    return content;
  } catch {
    return null;
  }
}
