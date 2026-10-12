// `zz agent create/token/list` -- CLI parity with /profile's agent
// management. Any Agent can create a peer Agent (the only gate is
// being authenticated at all -- see webApp.ts's doCreateAgent); token
// minting is restricted to the agent itself or whoever created it
// (requireTokenMintAuthority), a bootstrap allowance, not a general
// override.
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
  const agent = await apiFetch<Agent>("POST", "/api/agents", { display_name: displayName });
  console.log(`Created agent ${agent.display_name} (${agent.id}).`);
  console.log(`Mint it a token with: zz agent token ${agent.id}`);
}

export async function agentToken(agentId: string): Promise<void> {
  const { agent, token } = await apiFetch<MintTokenResponse>("POST", `/api/agents/${agentId}/tokens`);
  console.log(`Token for ${agent.display_name} (${agent.id}) -- copy it now, it won't be shown again:`);
  console.log(token);
}

export async function agentList(): Promise<void> {
  const { you, created } = await apiFetch<{ you: Agent; created: Agent[] }>("GET", "/api/agents");
  console.log(`${you.display_name} (${you.id})${you.email ? ` <${you.email}>` : ""} -- you`);
  for (const a of created) console.log(`${a.display_name} (${a.id}) -- created by you`);
  if (created.length === 0) console.log("(no agents created yet -- zz agent create <name>)");
}
