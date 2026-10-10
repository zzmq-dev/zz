// "Which repos do I care about" -- a small local config, deliberately not
// a negotiation protocol: an agent (human or automated) just maintains a
// list. How RBAC grants are actually issued/revoked is a later problem;
// this is only the "which repos should I even ask about" input to that.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ZzConfig {
  agent: string;
  repos: string[];
}

function configPath(): string {
  return process.env.ZZ_CONFIG ?? join(homedir(), ".zz", "config.json");
}

export function readConfig(overrides: { agent?: string; repos?: string[] } = {}): ZzConfig {
  const path = configPath();
  let base: Partial<ZzConfig> = {};
  if (existsSync(path)) {
    base = JSON.parse(readFileSync(path, "utf8")) as Partial<ZzConfig>;
  }
  const agent = overrides.agent ?? base.agent;
  const repos = overrides.repos ?? base.repos;
  if (!agent || !Array.isArray(repos) || repos.length === 0) {
    throw new Error(
      `no usable zz config (looked at ${path}${existsSync(path) ? "" : ", which doesn't exist"}). Provide --agent and --repos, or create a config: {"agent": "your-agent-id", "repos": ["owner/repo", ...]}`,
    );
  }
  return { agent, repos };
}
