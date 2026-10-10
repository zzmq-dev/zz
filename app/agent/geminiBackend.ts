// Google AI Studio (Gemini API) as a remote alternative to local
// Ollama -- mainly to isolate how much of this project's slowness is
// local-model compute vs. the surrounding system, since a production-
// grade remote serving stack removes the local-hardware variable
// entirely. Verified request/response shape directly against Google's
// own API reference (contents[]/parts[], systemInstruction,
// functionCall/functionResponse) rather than assumed.
import type { ChatBackend, ChatMessage } from "./chatBackend.js";
import type { ToolDef } from "./tools.js";

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error('Gemini backend needs an API key: set GEMINI_API_KEY (or GOOGLE_AI_API_KEY) in your environment or app/.env. Get a free-tier key at https://aistudio.google.com/apikey -- never paste the key itself into chat.');
  return key;
}

function toGeminiTools(tools: ToolDef[]) {
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

// Gemini has no "system" role and no "tool" role: the system message
// becomes systemInstruction (pulled out separately, never part of
// contents[]), and a tool result becomes a "user"-role functionResponse
// part -- its own real convention, not a guess, per the verified docs.
function toGeminiContents(messages: ChatMessage[]): { systemInstruction: { parts: GeminiPart[] } | undefined; contents: { role: string; parts: GeminiPart[] }[] } {
  let systemInstruction: { parts: GeminiPart[] } | undefined;
  const contents: { role: string; parts: GeminiPart[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    if (m.role === "tool") {
      let response: Record<string, unknown>;
      try {
        response = JSON.parse(m.content);
      } catch {
        response = { result: m.content };
      }
      contents.push({ role: "user", parts: [{ functionResponse: { name: m.name ?? "unknown", response } }] });
      continue;
    }
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const call of m.tool_calls ?? []) {
      parts.push({ functionCall: { name: call.function.name, args: call.function.arguments } });
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  return { systemInstruction, contents };
}

function fromGeminiResponse(data: { candidates?: { content?: { parts?: GeminiPart[] } }[] }): ChatMessage {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  let content = "";
  const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
  for (const p of parts) {
    if (p.text) content += p.text;
    if (p.functionCall) toolCalls.push({ function: { name: p.functionCall.name, arguments: p.functionCall.args } });
  }
  return { role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined };
}

export function createGeminiBackend(model: string): ChatBackend {
  return {
    name: `gemini:${model}`,
    async chat(messages, tools, onPartial) {
      const { systemInstruction, contents } = toGeminiContents(messages);
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
        body: JSON.stringify({ contents, systemInstruction, tools: toGeminiTools(tools) }),
      });
      if (!res.ok) throw new Error(`gemini chat failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      const message = fromGeminiResponse(data);
      // No streaming here yet (this call is non-streaming) -- still
      // report the final content once, so callers that only care about
      // "what's the latest text" (a TUI status line) don't need a
      // separate non-streaming code path.
      if (message.content) onPartial?.(message.content);
      return message;
    },
  };
}
