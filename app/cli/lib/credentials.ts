// Credentials for the REMOTE (Cloudflare) backend's JSON API -- a
// bearer token from `zz login`, separate from config.ts's
// "which repos do I care about" local config (a different concern:
// this is who you are to the remote API, that's what you watch).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveUserPath } from "./paths.js";

export interface ZzCredentials {
  apiBase: string;
  token: string;
  username: string; // the real identity -- no separate internal id (see worker migration 0006)
}

// The deployed Worker's current URL -- the one thing in the CLI that
// really is a hardcoded default, since a fresh `zz login` run has no
// other way to know where to start. Must match whatever host the
// OAuth redirect URIs (CF_OAUTH_REDIRECT_URI/GOOGLE_OAUTH_REDIRECT_URI,
// worker/wrangler.jsonc) are pinned to -- a fresh `zz login` with no
// credentials.json yet falls back to this default to open the browser,
// and if that host doesn't match the pinned redirect_uri's host, the
// state cookie (set on this host) never reaches the callback (lands
// on the redirect_uri's host), failing with "OAuth state mismatch"
// every time. Confirmed live: this was still the pre-zzmq.dev value
// after the redirect URIs were flipped, breaking exactly this path
// for anyone with no prior login. Override with ZZ_API_BASE if it
// ever needs to differ from the current canonical domain.
export const DEFAULT_API_BASE = "https://zzmq.dev";

function credentialsPath(): string {
  return process.env.ZZ_CREDENTIALS ? resolveUserPath(process.env.ZZ_CREDENTIALS) : join(homedir(), ".zz", "credentials.json");
}

export function readCredentials(): ZzCredentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ZzCredentials;
}

export function requireCredentials(): ZzCredentials {
  const creds = readCredentials();
  if (!creds) throw new Error(`not logged in -- run \`zz login\` first (looked for credentials at ${credentialsPath()})`);
  return creds;
}

export function writeCredentials(creds: ZzCredentials): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600); // best-effort; a real secret, same spirit as ~/.ssh keys
  } catch {
    // chmod can fail on some filesystems (e.g. certain Windows setups) -- not fatal
  }
}

export function apiBase(): string {
  return process.env.ZZ_API_BASE ?? readCredentials()?.apiBase ?? DEFAULT_API_BASE;
}

/** A real `git clone`-able URL with the bearer token embedded as Basic Auth userinfo, against the zz-maintainer Worker's own git smart-HTTP proxy (not a raw Artifacts URL -- see site/content/git-compatibility). Shared by `zz repo clone` and the remote work loop's own ensureCloned, so there's one place this convention lives. */
export function authedCloneUrl(base: string, token: string, slug: string): string {
  const host = base.replace(/^https?:\/\//, "");
  return `https://${encodeURIComponent(token)}@${host}/${slug}`;
}
