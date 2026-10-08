// BYO model, local only for now: a configured Ollama server. No backend
// here ever shells out to the `claude` CLI -- that's what caused the
// quota incident this replaces. A remote/API-key backend is deferred to
// later, not built here.
export interface ModelBackend {
  name: string;
  summarize(prompt: string): Promise<string | null>; // null = unreachable; caller falls back to mechanical text
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

/** Ollama if ZZ_OLLAMA_MODEL is set (or the default) and reachable; otherwise the null backend. */
export async function resolveModelBackend(): Promise<ModelBackend> {
  const baseUrl = process.env.ZZ_OLLAMA_HOST ?? "http://localhost:11434";
  const model = process.env.ZZ_OLLAMA_MODEL ?? "qwen2.5:14b-instruct";
  const backend = createOllamaBackend(baseUrl, model);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return backend;
  } catch {
    // fall through to null backend
  }
  console.error(`(ollama at ${baseUrl} not reachable; falling back to mechanical text)`);
  return createNullBackend();
}
