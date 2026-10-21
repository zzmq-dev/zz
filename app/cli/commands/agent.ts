// `zz agent create/token/list` -- CLI parity with /profile's "Managed
// agents" section. Any Agent can create a peer Agent (the only gate
// is being authenticated at all -- see webApp.ts's doCreateAgent);
// creating one issues its first token in the same call, no separate
// step. Minting an *additional* token is restricted to the agent
// itself or whoever manages it (requireTokenMintAuthority) -- a
// bootstrap/rotation allowance, not a general override.
import { createInterface } from "node:readline/promises";
import { apiFetch } from "../lib/api.js";
import { resolveMe } from "../lib/credentials.js";

// A local, minimal shape matching worker/src/accountsDb.ts's Agent --
// not imported directly: that file is typed against D1Database and
// other @cloudflare/workers-types ambients the main app/ tsconfig
// doesn't have configured, so cross-importing it would drag workers-
// only types into a Node CLI typecheck for no real benefit (the API
// boundary is just JSON over HTTP either way). `username` is the only
// identifier -- there's no separate internal id anymore (see worker
// migration 0006) -- and is now a literal did:guardian string for
// every agent, human or managed, e.g. "did:guardian:alice:zzmq.dev"
// (see worker migration 0017, #26).
interface Agent {
  display_name: string; // #21: "" until named -- by a human at creation, or by the agent itself later (named_at then distinguishes which)
  email: string | null;
  username: string;
  created_at: string;
  created_by: string | null;
  named_at: string | null;
}

interface MintTokenResponse {
  agent: Agent;
  token: string;
}

// `zz work --as <name>` (and `zz review`/`zz repo submit`) don't need
// a token from here at all -- they mint a fresh one on start and
// revoke it on exit, using your own `zz login` session's mint
// authority (lib/identity.ts). A token from these two commands is for
// the other case: a real standing credential for somewhere that isn't
// your own logged-in session -- a separate machine, a headless/CI
// run, anything using ZZ_ID.
function printZzId(username: string, token: string): void {
  console.log(`For a separate machine or headless run, set: ZZ_ID="${username}:${token}"`);
}

// #21: displayName omitted creates an unnamed agent -- it chooses its
// own name the first time it actually runs `zz work` (that bootstrap's
// own mandatory first step), rather than a human being required to
// pick one for it up front. Passing a name here still works exactly
// as before for every case (demos included) where a human genuinely
// wants to name an agent up front.
export async function agentCreate(displayName?: string): Promise<void> {
  const { token, ...agent } = await apiFetch<Agent & { token: string }>("POST", "/api/agents", { display_name: displayName });
  console.log(agent.display_name ? `Created agent ${agent.username}.` : `Created unnamed agent ${agent.username} -- it'll choose its own name the first time it runs "zz work".`);
  console.log(`Its first token -- copy it now, it won't be shown again:`);
  console.log(token);
  console.log(`Issue another with: zz agent token ${agent.username}`);
  printZzId(agent.username, token);
}

export async function agentToken(usernameOrId: string): Promise<void> {
  usernameOrId = resolveMe(usernameOrId);
  const { agent, token } = await apiFetch<MintTokenResponse>("POST", `/api/agents/${encodeURIComponent(usernameOrId)}/tokens`);
  console.log(`Token for ${agent.username} -- copy it now, it won't be shown again:`);
  console.log(token);
  printZzId(agent.username, token);
}

/**
 * Rotates an agent's own custodied did:guardian operational key --
 * same authority bar as `zz agent token` (yourself, or an agent you
 * created), but a completely different credential: this is the real
 * cryptographic identity key the did:guardian operation log is signed
 * with, not a zz bearer token (those are unaffected, and any already-
 * minted ones keep working -- rotation only replaces the key used to
 * sign FUTURE did:guardian operations like this one, nothing retroactive).
 */
export async function agentRotateKey(usernameOrId: string): Promise<void> {
  usernameOrId = resolveMe(usernameOrId);
  const { agent } = await apiFetch<{ agent: Agent; document: unknown }>("POST", `/api/agents/${encodeURIComponent(usernameOrId)}/rotate-key`);
  console.log(`Rotated ${agent.username}'s operational key.`);
}

export async function agentList(): Promise<void> {
  const { you, created } = await apiFetch<{ you: Agent; created: Agent[] }>("GET", "/api/agents");
  console.log(`${you.username} -- you`);
  for (const a of created) console.log(`${a.username} -- managed by you`);
  if (created.length === 0) console.log("(no managed agents yet -- zz agent create <name>)");
}

export async function agentDelete(username: string, opts: { yes?: boolean } = {}): Promise<void> {
  username = resolveMe(username);
  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(`This permanently deletes the managed agent "${username}" -- its tokens, login identities, and sessions. Type its username to confirm: `);
    rl.close();
    if (typed.trim() !== username) {
      console.error("Username didn't match -- not deleting anything.");
      process.exitCode = 1;
      return;
    }
  }
  await apiFetch("DELETE", `/api/agents/${encodeURIComponent(username)}`);
  console.log(`Deleted ${username}.`);
}
