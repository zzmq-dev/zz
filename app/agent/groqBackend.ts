// Groq as a remote backend -- OpenAI-compatible chat completions on
// LPU hardware, notable mainly for raw speed (observed far faster
// token generation than either local Ollama or Gemini's free tier) and
// a generous free quota (30 req/min, 1000/day at time of writing).
import { createOpenAiCompatBackend } from "./openaiCompatBackend.js";
import type { ChatBackend } from "./chatBackend.js";

function apiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("Groq backend needs an API key: set GROQ_API_KEY in your environment or app/.env. Get a free key at https://console.groq.com/keys -- never paste the key itself into chat.");
  return key;
}

export function createGroqBackend(model: string): ChatBackend {
  return createOpenAiCompatBackend({
    name: `groq:${model}`,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model,
    apiKey,
  });
}
