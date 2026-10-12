// `zz login`: opens a browser to the same OAuth flow the web app
// itself uses, then polls a single-use nonce until the callback mints
// a token and hands it back -- the same shape `gh auth login`/
// `wrangler login` use, built on our own OAuth flow instead of
// embedding a Google/Cloudflare client secret in a distributed CLI
// (which shouldn't happen -- those secrets belong server-side only).
import { exec } from "node:child_process";
import { apiBase, writeCredentials } from "../lib/credentials.js";

interface LoginStartResponse {
  nonce: string;
  url: string;
}

interface LoginPollResponse {
  status: "pending" | "ready";
  token?: string;
  agent?: { id: string; username: string };
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

export async function login(opts: { apiBase?: string; timeoutMs?: number } = {}): Promise<void> {
  const base = opts.apiBase ?? apiBase();
  const startResp = await fetch(`${base}/api/login/start`, { method: "POST" });
  if (!startResp.ok) throw new Error(`could not start login: ${startResp.status} ${await startResp.text()}`);
  const { nonce, url } = (await startResp.json()) as LoginStartResponse;

  console.log(`Opening ${url}`);
  console.log("(if it doesn't open automatically, paste that URL into a browser)");
  tryOpenBrowser(url);

  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60 * 1000);
  while (Date.now() < deadline) {
    await sleep(1500);
    const pollResp = await fetch(`${base}/api/login/poll?nonce=${encodeURIComponent(nonce)}`);
    if (!pollResp.ok) continue;
    const poll = (await pollResp.json()) as LoginPollResponse;
    if (poll.status === "ready" && poll.token && poll.agent) {
      writeCredentials({ apiBase: base, token: poll.token, agentId: poll.agent.id, username: poll.agent.username });
      console.log(`Logged in as ${poll.agent.username}.`);
      return;
    }
  }
  throw new Error("timed out waiting for login to complete -- run `zz login` again");
}
