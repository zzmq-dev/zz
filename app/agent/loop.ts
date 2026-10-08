// A minimal local tool-calling loop against Ollama's /api/chat, which
// genuinely supports OpenAI-style function-calling for tool-capable
// models (verified directly against qwen2.5:14b-instruct before building
// this). No Claude/Anthropic API, no BYOK -- local model only, per the
// project's current scope.
import type { ToolDef } from "./tools.js";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

function toOllamaTools(tools: ToolDef[]) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function summarizeForLog(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json) return String(value);
  return json.length > 200 ? json.slice(0, 197) + "..." : json;
}

export interface RunAgentOptions {
  systemPrompt: string;
  userMessage: string;
  tools: ToolDef[];
  maxTurns?: number;
  model?: string;
  baseUrl?: string;
}

export interface RunAgentResult {
  turns: number;
  finished: boolean;
  finalMessage: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const baseUrl = opts.baseUrl ?? process.env.ZZ_OLLAMA_HOST ?? "http://localhost:11434";
  const model = opts.model ?? process.env.ZZ_OLLAMA_MODEL ?? "qwen2.5:14b-instruct";
  const maxTurns = opts.maxTurns ?? 40;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userMessage },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools: toOllamaTools(opts.tools), stream: false }),
    });
    if (!res.ok) throw new Error(`ollama chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { message: ChatMessage };
    const { message } = data;
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      console.error(`[turn ${turn}] (no tool calls -- agent considers itself done)`);
      return { turns: turn, finished: true, finalMessage: message.content };
    }

    for (const call of message.tool_calls) {
      const tool = byName.get(call.function.name);
      console.error(`[turn ${turn}] -> ${call.function.name}(${summarizeForLog(call.function.arguments)})`);
      let result: unknown;
      if (!tool) {
        result = { error: `no such tool: ${call.function.name}` };
      } else {
        try {
          result = await tool.execute(call.function.arguments);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      console.error(`           <- ${summarizeForLog(result)}`);
      messages.push({ role: "tool", content: JSON.stringify(result) });
    }
  }

  console.error(`stopped after ${maxTurns} turns without the agent finishing on its own.`);
  return { turns: maxTurns, finished: false, finalMessage: "" };
}
