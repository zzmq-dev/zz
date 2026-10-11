// Cloudflare Workers AI as a remote backend -- OpenAI-compatible chat
// completions, free up to 10,000 Neurons/account/day with no card on
// file. Notable beyond just being another free tier: this is the
// actual platform zz targets for its remote backend (see the Cloudflare
// competition framing in site/content), so this doubles as a live
// preview of that deployment target's own model-serving story.
import { createOpenAiCompatBackend } from "./openaiCompatBackend.js";
import type { ChatBackend } from "./chatBackend.js";

function apiToken(): string {
  const key = process.env.CLOUDFLARE_API_TOKEN;
  if (!key) throw new Error("Cloudflare Workers AI backend needs an API token: set CLOUDFLARE_API_TOKEN in your environment or app/.env (create one with Workers AI permission at https://dash.cloudflare.com/profile/api-tokens) -- never paste the token itself into chat.");
  return key;
}

function accountId(): string {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) throw new Error("Cloudflare Workers AI backend needs your account id: set CLOUDFLARE_ACCOUNT_ID in your environment or app/.env (shown by `wrangler whoami`).");
  return id;
}

export function createCloudflareBackend(model: string): ChatBackend {
  return createOpenAiCompatBackend({
    name: `cloudflare:${model}`,
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId()}/ai/v1/chat/completions`,
    model,
    apiKey: apiToken,
  });
}
