// Shared repo resolution for CLI commands: parses "owner/repo", clones it
// locally if it isn't already (real `git clone`, not isomorphic-git --
// the CLI runs on a human's own machine, not in a Worker, so there's no
// reason not to use the fastest tool available for this one step; only the
// Ladder's own reads/writes go through the Workers-compatible engine).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Lazy, not module-scope: import.meta.url doesn't exist in workerd
// (confirmed directly building the Worker side -- a module-scope
// fileURLToPath(import.meta.url) crashes a Worker immediately on
// load, "Received undefined", even in a module nothing there ever
// calls). agent/tools.ts imports this file for run_in_sandbox, which
// can't run in a Worker anyway (no child_process there either) --
// deferring this until resolveRepo/ensureCloned actually run means
// the Worker bundle can include this file without crashing on load,
// since neither of those genuinely executes there.
let appRootCache: string | null = null;
function appRoot(): string {
  if (!appRootCache) {
    const here = dirname(fileURLToPath(import.meta.url));
    appRootCache = join(here, "..", "..");
  }
  return appRootCache;
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
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`expected "owner/repo", got "${slug}"`);
  }
  return { owner: parts[0], name: parts[1] };
}

export function resolveRepo(slug: string): ResolvedRepo {
  const { owner, name } = parseSlug(slug);
  // Nested by a sanitized owner segment, not just `name` -- a bare
  // "demo-repos/<name>" would collide if two different owners (now
  // genuinely possible with remote repos, e.g. two humans' repos both
  // named "shoes") happened to pick the same repo name.
  const ownerDir = owner.replace(/[^a-zA-Z0-9._-]/g, "_");
  return {
    slug,
    name,
    repoDir: join(appRoot(), "demo-repos", ownerDir, name),
    stateDir: join(appRoot(), "state", ownerDir, name),
  };
}

/** `remoteUrl`, when given, is a real git URL with credentials already embedded (cli/lib/credentials.ts's authedCloneUrl) -- the zz Worker's own git smart-HTTP proxy, cloned exactly like any other git remote. Omit it for the original GitHub-based local/demo path, unchanged. */
export function ensureCloned(repo: ResolvedRepo, remoteUrl?: string): void {
  if (existsSync(repo.repoDir)) {
    if (remoteUrl) syncClone(repo);
    return;
  }
  console.error(`cloning ${repo.slug}...`);
  execFileSync("git", ["clone", "--quiet", remoteUrl ?? `https://github.com/${repo.slug}.git`, repo.repoDir], { stdio: "inherit" });
}

/** Fast-forwards an existing clone to match the remote's current `main` -- needed in remote mode specifically, since other agents' commits land on the real remote, not in this local working copy, between one read and the next (local mode has no such gap: LocalBackend commits land directly in this same repoDir). */
export function syncClone(repo: ResolvedRepo): void {
  execFileSync("git", ["-C", repo.repoDir, "fetch", "--quiet", "origin", "main"], { stdio: "inherit" });
  execFileSync("git", ["-C", repo.repoDir, "reset", "--quiet", "--hard", "origin/main"], { stdio: "inherit" });
}
