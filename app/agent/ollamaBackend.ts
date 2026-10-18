// A local Ollama model via /api/chat, which genuinely supports
// OpenAI-style function-calling for tool-capable models (verified
// directly against qwen2.5:14b-instruct). Streams the real response:
// prose content arrives token-by-token, tool_calls arrive as one
// complete chunk once decided (verified directly against Ollama's own
// wire format) -- same total generation time as non-streaming, just
// delivered incrementally instead of buffered until the end.
import type { ChatBackend, ChatMessage } from "./chatBackend.js";
import type { ToolDef } from "./tools.js";

function toOllamaTools(tools: ToolDef[]) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function createOllamaBackend(model: string, baseUrl: string): ChatBackend {
  return {
    name: `ollama:${model}`,
    async chat(messages, tools, onPartial) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages, ...(tools.length ? { tools: toOllamaTools(tools) } : {}), stream: true }),
        });
      } catch (err) {
        // Node's own fetch error here is just "fetch failed" with no
        // mention of ollama, the URL, or what to do about it -- the
        // actual cause (connection refused, DNS failure, ...) is
        // buried in `.cause`, an AggregateError whose own .message is
        // empty (the real detail is one level deeper, in .errors), so
        // this reaches past both to find something worth printing.
        const inner = err instanceof Error && err.cause instanceof AggregateError ? err.cause.errors?.[0] : err instanceof Error ? err.cause : undefined;
        const detail = inner instanceof Error ? `: ${inner.message}` : "";
        throw new Error(`Couldn't reach Ollama at ${baseUrl}${detail} -- is it running? ("ollama serve", or point ZZ_OLLAMA_HOST at wherever it's running, or pass --provider groq/gemini/cloudflare instead).`);
      }
      if (!res.ok) throw new Error(`ollama chat failed: ${res.status} ${await res.text()}`);
      if (!res.body) throw new Error("ollama chat response had no body to stream");

      let content = "";
      let toolCalls: ChatMessage["tool_calls"];
      let buffer = "";
      // Same gap found live in openaiCompatBackend.ts's own stream loop,
      // confirmed here too: Ollama's NDJSON protocol puts `done: true` on
      // the final chunk specifically so a caller can tell a real
      // completion apart from a stream that just stopped (the local
      // Ollama process restarting mid-generation, a dropped connection to
      // a remote ZZ_OLLAMA_HOST) -- never checked before this, so a
      // truncated stream silently returned as if it were the real,
      // complete answer.
      let sawDone = false;
      for await (const rawChunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(rawChunk).toString("utf8");
        let newlineAt: number;
        while ((newlineAt = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineAt).trim();
          buffer = buffer.slice(newlineAt + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as { message?: { content?: string; tool_calls?: ChatMessage["tool_calls"] }; done?: boolean };
          if (chunk.message?.content) {
            content += chunk.message.content;
            onPartial?.(content);
          }
          if (chunk.message?.tool_calls) toolCalls = chunk.message.tool_calls;
          if (chunk.done) sawDone = true;
        }
      }
      if (!sawDone) {
        throw new Error(`ollama chat stream ended without done:true -- the connection was likely dropped mid-generation, not a genuinely complete response. ${content.length} chars of partial content discarded rather than silently treated as the real answer.`);
      }
      return { role: "assistant", content, tool_calls: toolCalls };
    },
  };
}
