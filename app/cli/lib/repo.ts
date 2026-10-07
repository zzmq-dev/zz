// Shared repo resolution for CLI commands: parses "owner/repo", clones it
// locally if it isn't already (real `git clone`, not isomorphic-git --
// the CLI runs on a human's own machine, not in a Worker, so there's no
// reason not to use the fastest tool available for this one step; only the
// Ladder's own reads/writes go through the Workers-compatible engine).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..");

export interface ResolvedRepo {
  slug: string; // "owner/repo"
  name: string; // "repo"
  repoDir: string; // real clone
  stateDir: string; // our own .zz/ state alongside it
}

export function parseSlug(slug: string): { owner: string; name: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`expected "owner/repo", got "${slug}"`);
  }
  return { owner: parts[0], name: parts[1] };
}

export function resolveRepo(slug: string): ResolvedRepo {
  const { name } = parseSlug(slug);
  return {
    slug,
    name,
    repoDir: join(appRoot, "demo-repos", name),
    stateDir: join(appRoot, "state", name),
  };
}

export function ensureCloned(repo: ResolvedRepo): void {
  if (existsSync(repo.repoDir)) return;
  console.error(`cloning ${repo.slug}...`);
  execFileSync("git", ["clone", "--quiet", `https://github.com/${repo.slug}.git`, repo.repoDir], { stdio: "inherit" });
}
