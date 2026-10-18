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

interface StreamedToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
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
        body: JSON.stringify({ model: opts.model, messages: toOpenAiMessages(messages), ...(tools.length ? { tools: toOpenAiTools(tools) } : {}), stream: true }),
      });
      if (!res.ok) throw new Error(`${opts.name} chat failed: ${res.status} ${await res.text()}`);
      if (!res.body) throw new Error(`${opts.name} chat response had no body to stream`);

      // SSE: "data: {...}\n\n" lines, a final "data: [DONE]" sentinel.
      // Prose content arrives incrementally (delta.content, appended
      // straight onto the running total); a tool call arrives as
      // fragments keyed by `index` (one chunk's id/name, several more
      // chunks each appending a few more characters of `arguments`'
      // JSON string) that have to be reassembled before
      // fromOpenAiResponse can parse them -- same two-tier shape
      // ollamaBackend.ts's own streaming loop documents (content
      // token-by-token, tool_calls complete once decided), just SSE
      // instead of NDJSON on the wire.
      let content = "";
      const toolCallsByIndex = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
      let buffer = "";
      // Tracked explicitly -- found live, likely the real explanation for
      // a pattern of submissions that only ever included tests, never the
      // implementation, across many retries: if the underlying connection
      // drops mid-stream (a rate limit killing an in-progress response is
      // exactly this shape, not just rejecting new requests), the `for
      // await` loop just ends with whatever partial `content` had
      // accumulated so far -- indistinguishable, before this, from a
      // genuinely complete response that happened to finish early. A
      // model generating "first the tests, then the implementation" and
      // getting cut off after the tests would silently look like a
      // complete, if wrong, submission every single time.
      let sawDone = false;
      for await (const rawChunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(rawChunk).toString("utf8");
        let newlineAt: number;
        while ((newlineAt = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineAt).trim();
          buffer = buffer.slice(newlineAt + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            sawDone = true;
            continue;
          }
          if (!data) continue;
          let chunk: { choices?: { delta?: { content?: string; tool_calls?: StreamedToolCallDelta[] } }[] };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue; // a stray/partial SSE line -- skip rather than crash the whole stream over it
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onPartial?.(content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const existing = toolCallsByIndex.get(tc.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            toolCallsByIndex.set(tc.index, existing);
          }
        }
      }
      if (!sawDone) {
        throw new Error(`${opts.name} chat stream ended without a [DONE] sentinel -- the connection was likely dropped or rate-limited mid-generation, not a genuinely complete response. ${content.length} chars of partial content discarded rather than silently treated as the real answer.`);
      }
      const toolCalls = [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
      return fromOpenAiResponse({ choices: [{ message: { content, tool_calls: toolCalls.length ? toolCalls : undefined } }] });
    },
  };
}
