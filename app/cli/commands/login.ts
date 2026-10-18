// `zz login`: opens a browser to the same OAuth flow the web app
// itself uses, then polls a single-use nonce until the callback mints
// a token and hands it back -- the same shape `gh auth login`/
// `wrangler login` use, built on our own OAuth flow instead of
// embedding a Google/Cloudflare client secret in a distributed CLI
// (which shouldn't happen -- those secrets belong server-side only).
import { exec } from "node:child_process";
import { apiBase, readCredentials, writeCredentials } from "../lib/credentials.js";

interface LoginStartResponse {
  nonce: string;
  url: string;
}

interface LoginPollResponse {
  status: "pending" | "ready";
  token?: string;
  agent?: { username: string };
}

function tryOpenBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`, () => {
    // Best-effort only -- the URL is printed either way, nothing fails if this doesn't work.
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(opts: { apiBase?: string; timeoutMs?: number; quiet?: boolean } = {}): Promise<string> {
  const base = opts.apiBase ?? apiBase();
  const startResp = await fetch(`${base}/api/login/start`, { method: "POST" });
  if (!startResp.ok) throw new Error(`could not start login: ${startResp.status} ${await startResp.text()}`);
  const { nonce, url } = (await startResp.json()) as LoginStartResponse;

  // Suppressed for a caller rendering an alt-screen TUI (zz top's own
  // login hotkey) -- a stray console.log writes into the alt-screen
  // buffer at whatever the cursor's own position happens to be,
  // visually corrupting the rest of the frame instead of appearing as
  // a normal terminal line the way it does for `zz login` on its own.
  if (!opts.quiet) {
    console.log(`Opening ${url}`);
    console.log("(if it doesn't open automatically, paste that URL into a browser)");
  }
  tryOpenBrowser(url);

  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60 * 1000);
  while (Date.now() < deadline) {
    await sleep(1500);
    const pollResp = await fetch(`${base}/api/login/poll?nonce=${encodeURIComponent(nonce)}`);
    if (!pollResp.ok) continue;
    const poll = (await pollResp.json()) as LoginPollResponse;
    if (poll.status === "ready" && poll.token && poll.agent) {
      writeCredentials({ apiBase: base, token: poll.token, username: poll.agent.username });
      if (!opts.quiet) console.log(`Logged in as ${poll.agent.username}.`);
      return poll.agent.username;
    }
  }
  throw new Error("timed out waiting for login to complete -- run `zz login` again");
}

/** `zz login --whoami`: prints the currently logged-in account, if any, without starting a new login. Also shows the API base it's logged into, not just the username -- `--api-base`/ZZ_API_BASE can point a session at a non-default Worker, and that's exactly the kind of thing worth surfacing explicitly rather than leaving someone to guess why a command is behaving as a different account or backend than they expected. Throws (same message style as credentials.ts's own requireCredentials) rather than printing a soft "not logged in" and returning normally -- the same convention every other credential-requiring command here already follows, so a script checking login state via exit code gets the same behavior as every other zz command would. */
export function whoami(): void {
  const creds = readCredentials();
  if (!creds) throw new Error("not logged in -- run `zz login` first.");
  console.log(`${creds.username} (${creds.apiBase})`);
}
