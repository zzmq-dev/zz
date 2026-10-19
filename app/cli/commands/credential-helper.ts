// `zz credential-helper`: git's documented credential-helper protocol
// (gitcredentials(7)) -- a small program git invokes over stdin/
// stdout on demand, so a secret never gets written into the repo's
// own config at all. Reads ~/.zz/credentials.json, the store `zz
// login` already writes -- no new storage mechanism, and a bare `git
// pull` run outside the `zz` CLI gets the same credential
// transparently.
//
// Short-lived by self-rotation, not a server-enforced TTL (no expiry
// column exists on agent_tokens today, and adding one is a bigger,
// separate change to the core auth schema -- out of scope here): each
// "get" call mints a fresh token and revokes whatever this helper
// minted last time for that host, tracked in a small local state file
// -- at most one of these alive at once, continuously rotating, so a
// leaked token is a liability for about as long as it takes for the
// next git operation to run, not indefinitely.
//
// Full design: site/content/docs/credential-handling/.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { requireCredentials } from "../lib/credentials.js";
import { apiFetch, setActiveToken } from "../lib/api.js";

interface HelperState {
  [host: string]: { token: string };
}

function statePath(): string {
  return join(homedir(), ".zz", "credential-helper-state.json");
}

function readState(): HelperState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as HelperState;
  } catch {
    return {};
  }
}

function writeState(state: HelperState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort, same spirit as credentials.ts's own chmod
  }
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    attrs[line.slice(0, idx)] = line.slice(idx + 1).replace(/\r$/, "");
  }
  return attrs;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function credentialHelper(action: string): Promise<void> {
  const raw = await readStdin();
  const attrs = parseAttrs(raw);
  const creds = requireCredentials();
  const expectedHost = creds.apiBase.replace(/^https?:\/\//, "");

  // Not our host -- say nothing and exit cleanly, letting git fall
  // through to whatever else it would have done (another configured
  // helper, an interactive prompt). `zz repo clone` only ever
  // configures this helper scoped to credential.https://<that
  // host>.helper, so this is a defensive check, not the primary gate.
  if (attrs.host !== expectedHost) return;

  if (action === "get") {
    setActiveToken(creds.token);
    const state = readState();
    const previous = state[attrs.host]?.token;
    if (previous) {
      try {
        setActiveToken(previous);
        await apiFetch("POST", "/api/me/revoke");
      } catch {
        // best-effort -- an already-expired/revoked previous token is fine to ignore
      }
      setActiveToken(creds.token);
    }
    const { token } = await apiFetch<{ token: string }>("POST", `/api/agents/${encodeURIComponent(creds.username)}/tokens`);
    state[attrs.host] = { token };
    writeState(state);
    process.stdout.write(`username=x-token-auth\npassword=${token}\n`);
    return;
  }

  // store/erase: no-op. ~/.zz/credentials.json is the real store this
  // helper reads from; git's own credential cache has nothing to add
  // here (we mint fresh every "get" regardless of what store/erase
  // would otherwise remember) or remove (we never wrote anything into
  // git's own cache to begin with).
}
