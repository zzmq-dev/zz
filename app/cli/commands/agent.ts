// `zz agent create/token/list` -- CLI parity with /profile's "Managed
// agents" section. Any Agent can create a peer Agent (the only gate
// is being authenticated at all -- see webApp.ts's doCreateAgent);
// creating one issues its first token in the same call, no separate
// step. Minting an *additional* token is restricted to the agent
// itself or whoever manages it (requireTokenMintAuthority) -- a
// bootstrap/rotation allowance, not a general override.
import { apiFetch } from "../lib/api.js";

// A local, minimal shape matching worker/src/accountsDb.ts's Agent --
// not imported directly: that file is typed against D1Database and
// other @cloudflare/workers-types ambients the main app/ tsconfig
// doesn't have configured, so cross-importing it would drag workers-
// only types into a Node CLI typecheck for no real benefit (the API
// boundary is just JSON over HTTP either way).
interface Agent {
  id: string;
  display_name: string;
  email: string | null;
  created_at: string;
  created_by: string | null;
}

interface MintTokenResponse {
  agent: Agent;
  token: string;
}

export async function agentCreate(displayName: string): Promise<void> {
  const { token, ...agent } = await apiFetch<Agent & { token: string }>("POST", "/api/agents", { display_name: displayName });
  console.log(`Created agent ${agent.display_name} (${agent.id}). Its first token -- copy it now, it won't be shown again:`);
  console.log(token);
  console.log(`Issue another with: zz agent token ${agent.id}`);
}

export async function agentToken(agentId: string): Promise<void> {
  const { agent, token } = await apiFetch<MintTokenResponse>("POST", `/api/agents/${agentId}/tokens`);
  console.log(`Token for ${agent.display_name} (${agent.id}) -- copy it now, it won't be shown again:`);
  console.log(token);
}

export async function agentList(): Promise<void> {
  const { you, created } = await apiFetch<{ you: Agent; created: Agent[] }>("GET", "/api/agents");
  console.log(`${you.display_name} (${you.id})${you.email ? ` <${you.email}>` : ""} -- you`);
  for (const a of created) console.log(`${a.display_name} (${a.id}) -- managed by you`);
  if (created.length === 0) console.log("(no managed agents yet -- zz agent create <name>)");
}
