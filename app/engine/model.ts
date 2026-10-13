// BYO model: a configured Ollama server by default, or any of zz
// work's own --provider backends (groq/gemini/cloudflare) via
// createChatSummaryBackend below. No backend here ever shells out to
// the `claude` CLI -- that's what caused the quota incident this
// replaces.
import type { ChatBackend } from "../agent/chatBackend.js";
import { resolveBackend, type Provider } from "../cli/lib/resolveChatBackend.js";

export interface ModelBackend {
  name: string;
  summarize(prompt: string): Promise<string | null>; // null = unreachable; caller falls back to mechanical text
}

/** Adapts any ChatBackend (zz work's own groq/gemini/cloudflare/ollama backends, cli/lib/resolveChatBackend.ts) to this module's simpler summarize-only interface -- the ingestion pipeline (ladder-build.ts) only ever needs one-shot text generation, never tool-calling. Unlike the plain Ollama path below, a resolution failure here (e.g. a missing API key) throws rather than falling back to the null backend -- the same fail-fast-at-launch convention --provider already uses elsewhere, since a remote provider the caller explicitly asked for should error loudly, not silently degrade to mechanical text. */
export function createChatSummaryBackend(chat: ChatBackend): ModelBackend {
  return {
    name: chat.name,
    async summarize(prompt: string): Promise<string | null> {
      const reply = await chat.chat([{ role: "user", content: prompt }], []);
      return reply.content?.trim() || null;
    },
  };
}

export function createNullBackend(): ModelBackend {
  return { name: "null", summarize: async () => null };
}

export function createOllamaBackend(baseUrl: string, model: string): ModelBackend {
  return {
    name: `ollama:${model}`,
    async summarize(prompt: string): Promise<string | null> {
      try {
        const res = await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt, stream: false }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { response?: string };
        return data.response?.trim() || null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Ollama if ZZ_OLLAMA_MODEL is set (or the default) and reachable;
 * otherwise the null backend -- unchanged, still the zero-config
 * default for ladder-build's own ingestion summaries. A non-ollama
 * `provider` (zz ladder build --provider groq, etc.) skips the
 * reachability dance entirely and resolves through the same
 * --provider machinery zz work uses, via createChatSummaryBackend.
 */
export async function resolveModelBackend(provider?: Provider, model?: string): Promise<ModelBackend> {
  if (provider && provider !== "ollama") return createChatSummaryBackend(resolveBackend(provider, model));

  const baseUrl = process.env.ZZ_OLLAMA_HOST ?? "http://localhost:11434";
  const resolvedModel = model ?? process.env.ZZ_OLLAMA_MODEL ?? "qwen2.5:14b-instruct";
  const backend = createOllamaBackend(baseUrl, resolvedModel);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return backend;
  } catch {
    // fall through to null backend
  }
  console.error(`(ollama at ${baseUrl} not reachable; falling back to mechanical text)`);
  return createNullBackend();
}
