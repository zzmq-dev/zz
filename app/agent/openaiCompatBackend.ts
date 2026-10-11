// A generic backend for any provider speaking OpenAI's chat-completions
// wire format (verified directly against both Groq and Cloudflare
// Workers AI, which both implement it) -- one implementation instead of
// a bespoke one per provider, since (unlike Gemini) they genuinely
// share a shape: messages[] with system/user/assistant/tool roles,
// assistant tool_calls as {id, function:{name, arguments: JSON STRING}},
// and a "tool" message matched back by tool_call_id rather than by
// name.
import type { ChatBackend, ChatMessage } from "./chatBackend.js";
import type { ToolDef } from "./tools.js";

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function toOpenAiTools(tools: ToolDef[]) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

// OpenAI's shape needs a real tool_call_id round-tripped on the
// following "tool" message -- this project's internal ChatMessage only
// carries a tool-call's `name` (Ollama doesn't need more, matching by
// array order). Track the most recent assistant turn's calls and match
// by name to recover the id, the same limitation the Gemini backend
// already accepts for functionResponse matching.
function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let lastAssistantCalls: OpenAiToolCall[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const matched = lastAssistantCalls.find((c) => c.function.name === m.name);
      out.push({ role: "tool", tool_call_id: matched?.id ?? m.name ?? "unknown", content: m.content });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls: OpenAiToolCall[] = m.tool_calls.map((c, i) => (c.raw as OpenAiToolCall | undefined) ?? { id: `call_${i}`, type: "function", function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) } });
      lastAssistantCalls = calls;
      // OpenAI itself accepts `content: null` here; Cloudflare Workers
      // AI's schema does not (confirmed directly: a real 400 "Type
      // mismatch... 'string' not in 'null'") -- an empty string is
      // accepted by both, so use that instead of leaning on an
      // OpenAI-specific allowance.
      out.push({ role: "assistant", content: m.content ?? "", tool_calls: calls });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function fromOpenAiResponse(data: { choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[] }): ChatMessage {
  const msg = data.choices?.[0]?.message;
  const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
  for (const c of msg?.tool_calls ?? []) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(c.function.arguments);
    } catch {
      args = {};
    }
    toolCalls.push({ function: { name: c.function.name, arguments: args }, raw: c });
  }
  return { role: "assistant", content: msg?.content ?? "", tool_calls: toolCalls.length ? toolCalls : undefined };
}

export function createOpenAiCompatBackend(opts: { name: string; url: string; model: string; apiKey: () => string }): ChatBackend {
  return {
    name: opts.name,
    async chat(messages, tools, onPartial) {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey()}` },
        // Several OpenAI-compatible providers (confirmed: Groq) reject an
        // empty `tools` array outright rather than treating it the same
        // as omitting the field -- needed for a plain-text, no-tools
        // generation call (agent/scriptedWork.ts), which intentionally
        // passes [].
        body: JSON.stringify({ model: opts.model, messages: toOpenAiMessages(messages), ...(tools.length ? { tools: toOpenAiTools(tools) } : {}) }),
      });
      if (!res.ok) throw new Error(`${opts.name} chat failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      const message = fromOpenAiResponse(data);
      // No streaming here yet (non-streaming call) -- same as Gemini,
      // still report the final content once so a status line fed by
      // onPartial has something to show.
      if (message.content) onPartial?.(message.content);
      return message;
    },
  };
}
