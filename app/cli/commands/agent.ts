// `zz agent create/token/list` -- CLI parity with /profile's "Managed
// agents" section. Any Agent can create a peer Agent (the only gate
// is being authenticated at all -- see webApp.ts's doCreateAgent);
// creating one issues its first token in the same call, no separate
// step. Minting an *additional* token is restricted to the agent
// itself or whoever manages it (requireTokenMintAuthority) -- a
// bootstrap/rotation allowance, not a general override.
import { apiFetch } from "../lib/api.js";
import { DEFAULT_API_BASE } from "../lib/credentials.js";

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

// Running `zz work`/`zz review` AS a manually-created agent (rather
// than via `zz login`'s OAuth flow, which writes
// ~/.zz/credentials.json itself) means hand-building a credentials
// file -- printed here, once, since this is the one moment you have
// both the token and the username together.
function printCredentialsSnippet(agent: Agent, token: string): void {
  console.log(`\nTo run \`zz work\`/\`zz review\` as ${agent.username} from a separate terminal (it's not what \`zz login\` writes -- that's OAuth-only), save this as a credentials file and point ZZ_CREDENTIALS at its path:`);
  console.log(JSON.stringify({ apiBase: DEFAULT_API_BASE, token, username: agent.username }, null, 2));
}

export async function agentCreate(displayName: string): Promise<void> {
  const { token, ...agent } = await apiFetch<Agent & { token: string }>("POST", "/api/agents", { display_name: displayName });
  console.log(`Created agent ${agent.username}. Its first token -- copy it now, it won't be shown again:`);
  console.log(token);
  console.log(`Issue another with: zz agent token ${agent.username}`);
  printCredentialsSnippet(agent, token);
}

export async function agentToken(usernameOrId: string): Promise<void> {
  const { agent, token } = await apiFetch<MintTokenResponse>("POST", `/api/agents/${encodeURIComponent(usernameOrId)}/tokens`);
  console.log(`Token for ${agent.username} -- copy it now, it won't be shown again:`);
  console.log(token);
  printCredentialsSnippet(agent, token);
}

export async function agentList(): Promise<void> {
  const { you, created } = await apiFetch<{ you: Agent; created: Agent[] }>("GET", "/api/agents");
  console.log(`${you.username} -- you`);
  for (const a of created) console.log(`${a.username} -- managed by you`);
  if (created.length === 0) console.log("(no managed agents yet -- zz agent create <name>)");
}
