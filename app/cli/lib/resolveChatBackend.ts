// Shared --provider/--model -> ChatBackend resolution, used by every
// command that talks to a model (zz work, and now zz ladder build's
// own ingestion summaries) -- extracted out of work.ts so a second
// command doesn't have to duplicate the same provider defaults/model
// names, or (worse) drift from them.
import type { ChatBackend } from "../../agent/chatBackend.js";
import { createOllamaBackend } from "../../agent/ollamaBackend.js";
import { createGeminiBackend } from "../../agent/geminiBackend.js";
import { createGroqBackend } from "../../agent/groqBackend.js";
import { createCloudflareBackend } from "../../agent/cloudflareBackend.js";

export type Provider = "ollama" | "gemini" | "groq" | "cloudflare";

export function resolveBackend(provider: Provider, model?: string): ChatBackend {
  // gemini-2.0-flash and gemini-2.5-flash are both retired for new API
  // keys as of this writing (confirmed directly: 404 "no longer
  // available to new users") -- gemini-3.8-flash is what Google's own
  // error message steers new keys toward, and the one actually
  // verified working against a real key.
  if (provider === "gemini") return createGeminiBackend(model ?? process.env.GEMINI_MODEL ?? "gemini-3.8-flash");
  // llama-3.3-70b-versatile (the commonly-documented free Groq model)
  // is gone from their catalog as of this writing (confirmed directly:
  // a real 404 "does not exist or you do not have access to it") --
  // openai/gpt-oss-120b is one of the models actually in their current
  // /v1/models listing with confirmed tool-calling support.
  if (provider === "groq") return createGroqBackend(model ?? process.env.GROQ_MODEL ?? "openai/gpt-oss-120b");
  if (provider === "cloudflare") return createCloudflareBackend(model ?? process.env.CLOUDFLARE_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const baseUrl = process.env.ZZ_OLLAMA_HOST ?? "http://localhost:11434";
  return createOllamaBackend(model ?? process.env.ZZ_OLLAMA_MODEL ?? "qwen2.5:14b-instruct", baseUrl);
}
