// `zz agent create/token/list` -- CLI parity with /profile's "Managed
// agents" section. Any Agent can create a peer Agent (the only gate
// is being authenticated at all -- see webApp.ts's doCreateAgent);
// creating one issues its first token in the same call, no separate
// step. Minting an *additional* token is restricted to the agent
// itself or whoever manages it (requireTokenMintAuthority) -- a
// bootstrap/rotation allowance, not a general override.
import { apiFetch } from "../lib/api.js";
import { saveAgentToken } from "../lib/identity.js";

// A local, minimal shape matching worker/src/accountsDb.ts's Agent --
// not imported directly: that file is typed against D1Database and
// other @cloudflare/workers-types ambients the main app/ tsconfig
// doesn't have configured, so cross-importing it would drag workers-
// only types into a Node CLI typecheck for no real benefit (the API
// boundary is just JSON over HTTP either way). `username` is the only
// identifier -- there's no separate internal id anymore (see worker
// migration 0006): a human's is their email; a managed agent's chains
// off its creator's, e.g. "thoward37@gmail.com[claude]" (see
// accountsDb.ts's computeUsername).
interface Agent {
  display_name: string;
  email: string | null;
  username: string;
  created_at: string;
  created_by: string | null;
}

interface MintTokenResponse {
  agent: Agent;
  token: string;
}

// Saved locally (~/.zz/agents.json) the moment a token is minted, so
// a later `zz work --as <name>` (or `zz review`/`zz repo submit`) has
// a real token to use with zero extra setup -- see lib/identity.ts's
// header for the full resolution order. Still printed too (for a
// headless/ZZ_ID use on another machine, where this local file won't
// exist).
function rememberAndPrint(agent: Agent, token: string): void {
  saveAgentToken(agent.username, token);
  console.log(`\nSaved locally -- \`zz work --as <name>\` (etc.) will pick this up automatically from now on.`);
  console.log(`For a separate machine/headless run instead, set: ZZ_ID="${agent.username}:${token}"`);
}

export async function agentCreate(displayName: string): Promise<void> {
  const { token, ...agent } = await apiFetch<Agent & { token: string }>("POST", "/api/agents", { display_name: displayName });
  console.log(`Created agent ${agent.username}. Its first token -- copy it now, it won't be shown again:`);
  console.log(token);
  console.log(`Issue another with: zz agent token ${agent.username}`);
  rememberAndPrint(agent, token);
}

export async function agentToken(usernameOrId: string): Promise<void> {
  const { agent, token } = await apiFetch<MintTokenResponse>("POST", `/api/agents/${encodeURIComponent(usernameOrId)}/tokens`);
  console.log(`Token for ${agent.username} -- copy it now, it won't be shown again:`);
  console.log(token);
  rememberAndPrint(agent, token);
}

export async function agentList(): Promise<void> {
  const { you, created } = await apiFetch<{ you: Agent; created: Agent[] }>("GET", "/api/agents");
  console.log(`${you.username} -- you`);
  for (const a of created) console.log(`${a.username} -- managed by you`);
  if (created.length === 0) console.log("(no managed agents yet -- zz agent create <name>)");
}
