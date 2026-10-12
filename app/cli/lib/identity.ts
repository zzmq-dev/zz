// Resolves "who is this remote command acting as, and what credential
// does it send" -- one place, used by `zz work`/`zz review`/
// `zz repo submit`, in priority order:
//
//  1. ZZ_ID="<username>:<token>" -- for automated/headless contexts
//     with no interactive `zz login` session at all (a CI runner, a
//     container with no ~/.zz).
//  2. ZZ_ID_FILE=<path to a file with that same "<username>:<token>"
//     text> -- the same thing, out of an env var (visible in `ps`,
//     shell history, some CI log capture) and into a file instead.
//  3. --as <name>: your own `zz login` session resolves who YOU are;
//     <name> expands to "<your username>[<name>]" (the standard
//     managed-agent naming -- see worker/src/accountsDb.ts's
//     computeUsername) unless it already looks fully-qualified
//     (contains "@" or "["), then looked up in the local per-agent
//     token registry (~/.zz/agents.json, populated automatically by
//     `zz agent create`/`zz agent token` while logged in). This is
//     NOT server-side impersonation -- your own token never acts as
//     another agent; this only ever sends that agent's own token,
//     which has to already exist locally for this to work.
//  4. No --as: your own `zz login` session, directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { apiBase, requireCredentials } from "./credentials.js";

export interface ResolvedIdentity {
  apiBase: string;
  token: string;
  username: string;
}

function agentRegistryPath(): string {
  return process.env.ZZ_AGENTS ?? join(homedir(), ".zz", "agents.json");
}

function readAgentRegistry(): Record<string, string> {
  const path = agentRegistryPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

/** Called by `zz agent create`/`zz agent token` (while logged in as yourself) so a later `zz work --as <name>` has a real token to use, with no separate credentials file to hand-build. Keyed by the agent's real (possibly disambiguated, e.g. "...[claude]-2") username, since that's what --as resolves to before looking it up here. */
export function saveAgentToken(username: string, token: string): void {
  const path = agentRegistryPath();
  const registry = readAgentRegistry();
  registry[username] = token;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600); // best-effort; these are real bearer tokens, same spirit as ~/.ssh keys
  } catch {
    // chmod can fail on some filesystems -- not fatal
  }
}

function parseIdPair(raw: string, source: string): { username: string; token: string } {
  const idx = raw.indexOf(":");
  if (idx === -1) throw new Error(`${source} must be "<username>:<token>", got "${raw}"`);
  return { username: raw.slice(0, idx).trim(), token: raw.slice(idx + 1).trim() };
}

export function resolveIdentity(asName?: string): ResolvedIdentity {
  if (process.env.ZZ_ID) {
    const { username, token } = parseIdPair(process.env.ZZ_ID, "ZZ_ID");
    return { apiBase: apiBase(), token, username };
  }
  if (process.env.ZZ_ID_FILE) {
    const raw = readFileSync(process.env.ZZ_ID_FILE, "utf8").trim();
    const { username, token } = parseIdPair(raw, "ZZ_ID_FILE");
    return { apiBase: apiBase(), token, username };
  }

  const human = requireCredentials();
  if (!asName) return { apiBase: human.apiBase, token: human.token, username: human.username };

  const fullUsername = /[@[]/.test(asName) ? asName : `${human.username}[${asName}]`;
  const registry = readAgentRegistry();
  const token = registry[fullUsername];
  if (!token) {
    throw new Error(`no saved token for ${fullUsername} -- run \`zz agent token ${asName}\` first (or \`zz agent create ${asName}\` if it doesn't exist yet)`);
  }
  return { apiBase: human.apiBase, token, username: fullUsername };
}
