// "Which repos do I care about" -- a small local config, deliberately not
// a negotiation protocol: an agent (human or automated) just maintains a
// list. How RBAC grants are actually issued/revoked is a later problem;
// this is only the "which repos should I even ask about" input to that.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveUserPath } from "./paths.js";

export interface ZzConfig {
  agent: string;
  repos: string[];
}

function configPath(): string {
  return process.env.ZZ_CONFIG ? resolveUserPath(process.env.ZZ_CONFIG) : join(homedir(), ".zz", "config.json");
}

/** `allowEmpty`: for a read-only viewer (`zz top`) that has something sensible to show with zero repos (an empty dashboard) -- `zz work`/`zz review` genuinely need at least one repo to do anything, so they never pass this. */
export function readConfig(overrides: { agent?: string; repos?: string[]; allowEmpty?: boolean } = {}): ZzConfig {
  const path = configPath();
  let base: Partial<ZzConfig> = {};
  if (existsSync(path)) {
    base = JSON.parse(readFileSync(path, "utf8")) as Partial<ZzConfig>;
  }
  const agent = overrides.agent ?? base.agent;
  const repos = overrides.repos ?? base.repos ?? (overrides.allowEmpty ? [] : undefined);
  if (!agent || !Array.isArray(repos) || (repos.length === 0 && !overrides.allowEmpty)) {
    throw new Error(
      `no usable zz config (looked at ${path}${existsSync(path) ? "" : ", which doesn't exist"}). Provide --agent and --repos, or create a config: {"agent": "your-agent-id", "repos": ["owner/repo", ...]}`,
    );
  }
  return { agent, repos };
}

/** `overrideRepos` if given, else the config file's own `repos` if the file exists and has a non-empty list, else null -- meaning "nothing explicit," distinct from readConfig's allowEmpty (which conflates a missing file with a genuinely empty list). `zz top`'s repo-resolution chain needs that distinction: it only falls through to a remote/local auto-discovery fallback when there's truly nothing explicit configured. */
export function configuredRepos(overrideRepos?: string[]): string[] | null {
  if (overrideRepos && overrideRepos.length > 0) return overrideRepos;
  const path = configPath();
  if (!existsSync(path)) return null;
  const base = JSON.parse(readFileSync(path, "utf8")) as Partial<ZzConfig>;
  return base.repos && base.repos.length > 0 ? base.repos : null;
}

/** Explore's "track" action, for the two cases with no server-side "repos I care about" list to update instead (remote-not-logged-in, local): grows ~/.zz/config.json in place rather than requiring the user to edit it by hand. No-op if already present. Defaults a never-existing config to the same "zz-top-viewer" agent id `top.ts` already uses for its own read-only readConfig calls. */
export function addRepoToConfig(slug: string): void {
  const path = configPath();
  let current: ZzConfig = { agent: "zz-top-viewer", repos: [] };
  if (existsSync(path)) {
    const base = JSON.parse(readFileSync(path, "utf8")) as Partial<ZzConfig>;
    current = { agent: base.agent ?? current.agent, repos: base.repos ?? [] };
  }
  if (current.repos.includes(slug)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...current, repos: [...current.repos, slug] }, null, 2) + "\n", "utf8");
}
