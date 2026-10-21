// "Which Lanes do I care about" -- a small local config, deliberately not
// a negotiation protocol: an agent (human or automated) just maintains a
// list. How RBAC grants are actually issued/revoked is a later problem;
// this is only the "which Lanes should I even ask about" input to that.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveUserPath } from "./paths.js";

export interface ZzConfig {
  agent: string;
  lanes: string[];
}

function configPath(): string {
  return process.env.ZZ_CONFIG ? resolveUserPath(process.env.ZZ_CONFIG) : join(homedir(), ".zz", "config.json");
}

/** Reads the config file's own JSON, accepting either the current "lanes" key or the old "repos" one it replaces -- an already-existing config.json out there still has the old key, and should keep working unmigrated rather than silently going empty. Never writes the old key back; addRepoToConfig below naturally migrates a file to "lanes" the next time anything touches it. */
function readRawConfig(path: string): Partial<ZzConfig> {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ZzConfig> & { repos?: string[] };
  return { agent: raw.agent, lanes: raw.lanes ?? raw.repos };
}

/** `allowEmpty`: for a read-only viewer (`zz top`) that has something sensible to show with zero Lanes (an empty dashboard) -- `zz work`/`zz review` genuinely need at least one Lane to do anything, so they never pass this. */
export function readConfig(overrides: { agent?: string; lanes?: string[]; allowEmpty?: boolean } = {}): ZzConfig {
  const path = configPath();
  const base = readRawConfig(path);
  const agent = overrides.agent ?? base.agent;
  const lanes = overrides.lanes ?? base.lanes ?? (overrides.allowEmpty ? [] : undefined);
  if (!agent || !Array.isArray(lanes) || (lanes.length === 0 && !overrides.allowEmpty)) {
    throw new Error(
      `no usable zz config (looked at ${path}${existsSync(path) ? "" : ", which doesn't exist"}). Provide --agent and --lanes, or create a config: {"agent": "your-agent-id", "lanes": ["owner/name", ...]}`,
    );
  }
  return { agent, lanes };
}

/** `overrideLanes` if given, else the config file's own `lanes` if the file exists and has a non-empty list, else null -- meaning "nothing explicit," distinct from readConfig's allowEmpty (which conflates a missing file with a genuinely empty list). `zz top`'s own resolution chain needs that distinction: it only falls through to a remote/local auto-discovery fallback when there's truly nothing explicit configured. */
export function configuredRepos(overrideLanes?: string[]): string[] | null {
  if (overrideLanes && overrideLanes.length > 0) return overrideLanes;
  const base = readRawConfig(configPath());
  return base.lanes && base.lanes.length > 0 ? base.lanes : null;
}

/** Explore's "track" action, for the two cases with no server-side "Lanes I care about" list to update instead (remote-not-logged-in, local): grows ~/.zz/config.json in place rather than requiring the user to edit it by hand. No-op if already present. Defaults a never-existing config to the same "zz-top-viewer" agent id `top.ts` already uses for its own read-only readConfig calls. */
export function addRepoToConfig(slug: string): void {
  const path = configPath();
  const base = readRawConfig(path);
  const current: ZzConfig = { agent: base.agent ?? "zz-top-viewer", lanes: base.lanes ?? [] };
  if (current.lanes.includes(slug)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...current, lanes: [...current.lanes, slug] }, null, 2) + "\n", "utf8");
}
