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

// Some models (observed with qwen3-coder:30b) serialize a complex
// argument -- an object or array meant to be nested JSON -- as a JSON
// string instead of passing it as a native nested value. Parse any
// top-level string argument that looks like JSON before it reaches the
// tool, rather than letting every tool guess at this independently.
function coerceJsonStringArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        out[key] = JSON.parse(value);
        continue;
      } catch {
        // not actually JSON; fall through and keep the raw string
      }
    }
    out[key] = value;
  }
  return out;
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

const MAX_GIVE_UP_NUDGES = 2;

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const baseUrl = opts.baseUrl ?? process.env.ZZ_OLLAMA_HOST ?? "http://localhost:11434";
  const model = opts.model ?? process.env.ZZ_OLLAMA_MODEL ?? "qwen2.5:14b-instruct";
  const maxTurns = opts.maxTurns ?? 40;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userMessage },
  ];

  let lastTurnHadError = false;
  let nudgesUsed = 0;

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
      // Stopping right after an unresolved tool error usually means the
      // model gave up, not that it finished -- the one real failure mode
      // this project has actually hit. Nudge it to retry or explicitly
      // deny, rather than trusting silence as completion, up to a small
      // bounded number of times so a genuinely stuck agent still ends.
      if (lastTurnHadError && nudgesUsed < MAX_GIVE_UP_NUDGES) {
        nudgesUsed += 1;
        console.error(`[turn ${turn}] (stopped right after a tool error -- nudging instead of ending, ${nudgesUsed}/${MAX_GIVE_UP_NUDGES})`);
        messages.push({
          role: "user",
          content: "Your last tool call failed and you haven't resolved it -- you stopped instead of retrying. Either fix the error and retry the call, or if you genuinely can't complete the work, call ask_answer with action \"deny\" and explain why. Don't just stop without one of those.",
        });
        continue;
      }
      console.error(`[turn ${turn}] (no tool calls -- agent considers itself done)`);
      return { turns: turn, finished: true, finalMessage: message.content };
    }

    lastTurnHadError = false;
    for (const call of message.tool_calls) {
      const tool = byName.get(call.function.name);
      console.error(`[turn ${turn}] -> ${call.function.name}(${summarizeForLog(call.function.arguments)})`);
      let result: unknown;
      if (!tool) {
        result = { error: `no such tool: ${call.function.name}` };
      } else {
        try {
          result = await tool.execute(coerceJsonStringArgs(call.function.arguments));
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (result && typeof result === "object" && "error" in result) lastTurnHadError = true;
      console.error(`           <- ${summarizeForLog(result)}`);
      messages.push({ role: "tool", content: JSON.stringify(result) });
    }
  }

  console.error(`stopped after ${maxTurns} turns without the agent finishing on its own.`);
  return { turns: maxTurns, finished: false, finalMessage: "" };
}
