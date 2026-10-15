// Shared repo resolution for CLI commands: parses "owner/repo", clones it
// locally if it isn't already (real `git clone`, not isomorphic-git --
// the CLI runs on a human's own machine, not in a Worker, so there's no
// reason not to use the fastest tool available for this one step; only the
// Ladder's own reads/writes go through the Workers-compatible engine).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAnchor } from "../../engine/ladderNotes.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { resolveMe } from "./credentials.js";

// `~/.zz/repos`/`~/.zz/state`, not anywhere relative to this module's own
// location -- same convention as credentials.ts/config.ts's ~/.zz/*.json.
// This used to be package-root-relative (two dirs up from this file), which
// quietly worked only because every real use so far ran straight out of
// the dev repo; a globally `npm install -g`'d copy of this package has no
// business writing a user's real work clones into wherever npm happened to
// put its own installed files (not always writable, not meant to hold user
// data, and gets blown away on upgrade/reinstall).
function zzHome(): string {
  return join(homedir(), ".zz");
}

export interface ResolvedRepo {
  slug: string; // "owner/repo"
  name: string; // "repo"
  repoDir: string; // real clone
  stateDir: string; // our own .zz/ state alongside it
}

export function parseSlug(slug: string): { owner: string; name: string } {
  if (typeof slug !== "string" || !slug) {
    throw new Error(`expected a "repo" argument shaped "owner/repo", got ${JSON.stringify(slug)} -- every tool call that touches a repo needs one, even if you already passed it on an earlier call.`);
  }
  slug = resolveMe(slug);
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`expected "owner/repo", got "${slug}"`);
  }
  return { owner: parts[0], name: parts[1] };
}

export function resolveRepo(slug: string): ResolvedRepo {
  const { owner, name } = parseSlug(slug);
  // Rebuilt from the resolved owner/name, not the original parameter --
  // parseSlug's own "slug = resolveMe(slug)" reassignment is local to
  // its own call frame and never touches this function's `slug`
  // binding. Confirmed live: this returned ResolvedRepo.slug as the
  // raw, still-unresolved "@me/mathkit", so every caller using it
  // directly (not owner/name separately) silently went right back to
  // the unresolved value -- "no such repo \"@me/mathkit\"" the moment
  // anything tried to look it up by that slug.
  slug = `${owner}/${name}`;
  // Nested by a sanitized owner segment, not just `name` -- a bare
  // "demo-repos/<name>" would collide if two different owners (now
  // genuinely possible with remote repos, e.g. two humans' repos both
  // named "shoes") happened to pick the same repo name.
  const ownerDir = owner.replace(/[^a-zA-Z0-9._-]/g, "_");
  // On disk only: a shard's name segment carries bracket-delimited task
  // slugs (computeShardSlug, worker/src/webApp.ts, e.g.
  // "pants[foo][bar]") -- real brackets are legal in a directory name
  // but clunky to type/tab-complete/paste, so locally this becomes a
  // double-underscore delimiter instead ("pants__foo__bar"). `slug` and
  // `name` themselves are untouched -- they're the real identifiers
  // used everywhere else (API calls, display, the protocol itself).
  const nameDir = name.replace(/\[/g, "__").replace(/\]/g, "");
  return {
    slug,
    name,
    repoDir: join(zzHome(), "repos", ownerDir, nameDir),
    stateDir: join(zzHome(), "state", ownerDir, nameDir),
  };
}

// TEMPORARY, pending a Cloudflare fix -- same reasoning as
// cli/commands/repo.ts's repoClone, see its own comment and the case
// study it links (site/content/docs/case-studies/
// git-incremental-fetch-sideband-error): any `have`-line negotiation
// against a repo with real history can corrupt the response
// ("fetch-pack: protocol error: bad band #78"), a real bug in
// Cloudflare Artifacts' own git-upload-pack. This isn't only a risk
// for a user's own `git pull` -- every zz-managed local clone under
// ~/.zz/repos/ runs this same negotiation on its own, repeatedly:
// syncClone below (called before every claimed ask, remote mode) and
// runCoordinatorSubmitChangeset's own fetch of a shard's objects
// (agent/scriptedWork.ts) both send that clone's own `have` list
// regardless of which remote they're actually fetching from -- found
// live exactly this way, a `zz work` process crashing on a fetch from
// a task shard, not a user-run `git pull` at all. `noop` skips the
// negotiation entirely; see repoClone's own comment for the real
// tradeoff. Set unconditionally, every call, cheap and idempotent --
// this is also the one thing that retroactively protects a clone
// that was already sitting in ~/.zz/repos/ before this existed.
function disableFetchNegotiation(repoDir: string): void {
  execFileSync("git", ["-C", repoDir, "config", "fetch.negotiationAlgorithm", "noop"], { stdio: "inherit" });
}

/** `remoteUrl`, when given, is a real git URL with credentials already embedded (cli/lib/credentials.ts's authedCloneUrl) -- the zz Worker's own git smart-HTTP proxy, cloned exactly like any other git remote. Omit it for the original GitHub-based local/demo path, unchanged. */
export function ensureCloned(repo: ResolvedRepo, remoteUrl?: string): void {
  if (existsSync(repo.repoDir)) {
    if (remoteUrl) {
      disableFetchNegotiation(repo.repoDir);
      syncClone(repo);
    }
    return;
  }
  console.error(`cloning ${repo.slug}...`);
  execFileSync("git", ["clone", "--quiet", remoteUrl ?? `https://github.com/${repo.slug}.git`, repo.repoDir], { stdio: "inherit" });
  if (remoteUrl) disableFetchNegotiation(repo.repoDir);
}

/** Fast-forwards an existing clone to match the remote's current `main` -- needed in remote mode specifically, since other agents' commits land on the real remote, not in this local working copy, between one read and the next (local mode has no such gap: LocalBackend commits land directly in this same repoDir). */
export function syncClone(repo: ResolvedRepo): void {
  disableFetchNegotiation(repo.repoDir);
  execFileSync("git", ["-C", repo.repoDir, "fetch", "--quiet", "origin", "main"], { stdio: "inherit" });
  execFileSync("git", ["-C", repo.repoDir, "reset", "--quiet", "--hard", "origin/main"], { stdio: "inherit" });
}

/** Same definition `zz ladder build` itself uses to decide whether the file tree already got onboarded (cli/commands/ladder-build.ts's own isPresent check on REPO_RUNG_PATH) -- not a new check, just this one reused so `zz top --local`'s discovery agrees with onboarding about what "onboarded" means. No existsSync short-circuit on stateDir: confirmed live that readAnchor finds real content (it's a git note on repoDir's own clone) even when stateDir doesn't exist on disk at all, so a "does the directory exist" guard here only produces false negatives. */
export async function isLocallyOnboarded(repo: ResolvedRepo): Promise<boolean> {
  return (await readAnchor(repo.repoDir, repo.stateDir, REPO_RUNG_PATH)) !== null;
}

/** Walks up from `dir` (default: cwd) to find the enclosing git repo (if any) and parses its `origin` remote as a GitHub "owner/repo" slug. Null for a non-git directory, a git repo with no `origin`, or an origin that isn't github.com -- `zz ladder build` itself only supports GitHub-hosted repos (clones from github.com, fetches issues/PRs via the GitHub API), so there's no onboarding command to suggest for anything else; callers should say so plainly rather than inventing one. */
export function inferGitHubSlugFromDir(dir: string = process.cwd()): string | null {
  let root: string;
  try {
    root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null; // not inside a git repo
  }
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null; // no "origin" remote
  }
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** `inferGitHubSlugFromDir`, defaulted to the process's own cwd -- kept as a separate named export since most callers (top.ts's startup discovery) want exactly that and shouldn't have to pass `process.cwd()` explicitly. */
export function inferGitHubSlugFromCwd(): string | null {
  return inferGitHubSlugFromDir();
}
