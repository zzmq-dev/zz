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
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, ...(tools.length ? { tools: toOllamaTools(tools) } : {}), stream: true }),
      });
      if (!res.ok) throw new Error(`ollama chat failed: ${res.status} ${await res.text()}`);
      if (!res.body) throw new Error("ollama chat response had no body to stream");

      let content = "";
      let toolCalls: ChatMessage["tool_calls"];
      let buffer = "";
      for await (const rawChunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(rawChunk).toString("utf8");
        let newlineAt: number;
        while ((newlineAt = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineAt).trim();
          buffer = buffer.slice(newlineAt + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as { message?: { content?: string; tool_calls?: ChatMessage["tool_calls"] } };
          if (chunk.message?.content) {
            content += chunk.message.content;
            onPartial?.(content);
          }
          if (chunk.message?.tool_calls) toolCalls = chunk.message.tool_calls;
        }
      }
      return { role: "assistant", content, tool_calls: toolCalls };
    },
  };
}
