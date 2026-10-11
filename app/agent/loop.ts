// A generic tool-calling loop over any ChatBackend (agent/
// chatBackend.ts) -- local Ollama or a remote API (Gemini). The loop
// itself knows nothing about either provider's wire format; it just
// exchanges ChatMessages and executes whatever tool_calls come back.
import type { ToolDef } from "./tools.js";
import type { ChatBackend, ChatMessage } from "./chatBackend.js";

// Full (pretty-printed, multi-line) rather than a one-line truncated
// summary -- the activity log is meant to show what the model is
// actually doing (the real diffs/content in a commit_changeset or
// ladder_write_rung call, not just its shape), the same way Claude
// Code's own transcript shows full tool calls, not a gist of them. The
// cap is generous, not absent, so one pathological payload can't lock
// up the log.
function formatForLog(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value, null, 2);
  if (!json) return String(value);
  return json.length > 6000 ? json.slice(0, 5997) + "..." : json;
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
  backend: ChatBackend;
  maxTurns?: number;
  /** Called with each log line instead of `console.error`, so a TUI can capture the agent's activity instead of it scrolling over the rendered screen. Defaults to `console.error`. */
  onLog?: (line: string) => void;
  /**
   * Called repeatedly with the accumulated text-so-far of the current
   * turn's response as it streams in (verified against Ollama's real
   * wire format: prose content arrives token-by-token, tool_calls
   * arrive as one complete chunk once decided -- same total generation
   * time as non-streaming, just delivered incrementally instead of
   * buffered until the end). A TUI wires this to a live status line
   * instead of a log line, so it doesn't spam the scrollback with one
   * entry per token.
   */
  onPartial?: (textSoFar: string) => void;
  /**
   * Checked whenever the model stops calling tools, before trusting
   * that as completion -- observed repeatedly: a model describes a
   * plan in prose ("Now I'll implement X and test it") and then simply
   * stops without ever calling a tool, which used to be read as
   * "finished" even though nothing happened. Defaults to always true
   * (trust the stop) for callers that don't have a concrete way to
   * check; callers that do (e.g. "is the ask I was handed actually
   * answered yet") should supply a real one.
   */
  isActuallyDone?: () => boolean;
}

export interface RunAgentResult {
  turns: number;
  finished: boolean;
  finalMessage: string;
}

const MAX_GIVE_UP_NUDGES = 2;
const MAX_BACKEND_RETRIES = 3;
const BACKEND_RETRY_DELAYS_MS = [3000, 8000, 15000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A remote backend can fail transiently (rate limit, "high demand"
// 503s -- observed directly against Gemini's free tier) in ways a
// local one rarely does once it's loaded. An uncaught failure used to
// crash the entire zz work process, not just this one attempt --
// bounded retry with backoff first; null means give up on this
// attempt (not the process) once that's exhausted.
async function chatWithRetry(backend: ChatBackend, messages: ChatMessage[], tools: ToolDef[], onPartial: ((text: string) => void) | undefined, turn: number, log: (line: string) => void): Promise<ChatMessage | null> {
  for (let attempt = 1; attempt <= MAX_BACKEND_RETRIES; attempt++) {
    try {
      return await backend.chat(messages, tools, onPartial);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_BACKEND_RETRIES) {
        log(`[turn ${turn}] ${backend.name} failed after ${MAX_BACKEND_RETRIES} attempts, giving up on this attempt: ${msg}`);
        return null;
      }
      const delay = BACKEND_RETRY_DELAYS_MS[attempt - 1] ?? BACKEND_RETRY_DELAYS_MS[BACKEND_RETRY_DELAYS_MS.length - 1];
      log(`[turn ${turn}] ${backend.name} failed (attempt ${attempt}/${MAX_BACKEND_RETRIES}), retrying in ${delay / 1000}s: ${msg}`);
      await sleep(delay);
    }
  }
  return null;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const maxTurns = opts.maxTurns ?? 40;
  const log = opts.onLog ?? ((line: string) => console.error(line));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userMessage },
  ];

  let lastError: { tool: string; message: string } | null = null;
  let nudgesUsed = 0;
  const isActuallyDone = opts.isActuallyDone ?? (() => true);

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Logged *before* the request, not just after -- a non-streaming
    // call can legitimately take 10-30+ seconds for a 14B-class local
    // model, and with nothing printed in that window it reads as hung
    // rather than working. Reporting elapsed time after the fact turns
    // "is this stuck?" into a concrete, comparable number across turns.
    log(`[turn ${turn}] waiting for ${opts.backend.name}...`);
    const turnStart = Date.now();
    const message = await chatWithRetry(opts.backend, messages, opts.tools, opts.onPartial, turn, log);
    if (!message) return { turns: turn, finished: false, finalMessage: "" };
    log(`[turn ${turn}] got a response in ${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
    messages.push(message);

    if (message.content && message.content.trim()) {
      log(`[turn ${turn}] says: ${message.content.trim()}`);
    }

    if (!message.tool_calls || message.tool_calls.length === 0) {
      // Stopping doesn't mean finished -- two real failure modes this
      // project has actually hit, both caught by the same check (is
      // whatever the caller cares about actually done?) rather than
      // trusting silence as completion: (1) stopping right after an
      // unresolved tool error, the model having given up instead of
      // retrying; (2) describing a plan in prose ("I'll implement X and
      // test it") and then simply stopping without ever calling a tool
      // to do it. Nudge either way, up to a small bounded number of
      // times so a genuinely stuck agent still ends.
      if (!isActuallyDone() && nudgesUsed < MAX_GIVE_UP_NUDGES) {
        nudgesUsed += 1;
        // Naming the specific failing tool and its exact error combats
        // a real observed failure mode: the model blaming a *different*,
        // already-succeeded call for an error that actually came from
        // the one right before it stopped.
        const reason = lastError
          ? `Your last tool call (${lastError.tool}) failed with: ${lastError.message} -- fix that specific call (check which arguments it actually needs) and retry it, or if you genuinely can't complete the work, call ask_answer with action "deny" and explain why. Don't just stop without one of those.`
          : `You described what you'd do but didn't actually call the tools to do it -- describing a plan isn't the same as executing it, and the work isn't done yet. Call the tools now to actually make the change/test/submit, then ask_answer once it's genuinely done.`;
        log(`[turn ${turn}] (stopped without finishing -- nudging instead of ending, ${nudgesUsed}/${MAX_GIVE_UP_NUDGES})`);
        messages.push({ role: "user", content: reason });
        continue;
      }
      log(`[turn ${turn}] (no tool calls -- agent considers itself done)`);
      return { turns: turn, finished: true, finalMessage: message.content };
    }

    lastError = null;
    for (const call of message.tool_calls) {
      const tool = byName.get(call.function.name);
      log(`[turn ${turn}] -> ${call.function.name}(\n${formatForLog(call.function.arguments)}\n)`);
      let result: unknown;
      if (!tool) {
        result = { error: `no such tool: ${call.function.name}` };
      } else {
        try {
          result = await tool.execute(coerceJsonStringArgs(call.function.arguments));
        } catch (err) {
          const resolved = err instanceof Error && (err as { resolved?: boolean }).resolved === true;
          result = { error: err instanceof Error ? err.message : String(err), ...(resolved ? { resolved: true } : {}) };
        }
      }
      if (result && typeof result === "object" && "error" in result) {
        lastError = { tool: call.function.name, message: String((result as { error: unknown }).error) };
      }
      log(`[turn ${turn}] <- ${call.function.name} result:\n${formatForLog(result)}`);
      // A structural "this work is already resolved" signal (see
      // engine/lane.ts's duplicate-answer guard) ends the loop here,
      // regardless of what the model does next -- observed repeatedly:
      // a model that retries this exact call despite the error text
      // keeps retrying it rather than stopping on its own.
      if (result && typeof result === "object" && (result as { resolved?: boolean }).resolved === true) {
        log(`[turn ${turn}] (already resolved -- ending here instead of letting the model keep retrying)`);
        return { turns: turn, finished: true, finalMessage: "" };
      }
      messages.push({ role: "tool", content: JSON.stringify(result), name: call.function.name });
    }
  }

  log(`stopped after ${maxTurns} turns without the agent finishing on its own.`);
  return { turns: maxTurns, finished: false, finalMessage: "" };
}
