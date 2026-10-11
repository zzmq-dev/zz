// The one seam between the generic tool-calling loop (agent/loop.ts)
// and whichever model actually answers -- a local Ollama model or a
// remote API (Gemini today). The loop only ever talks to this
// interface, never to a provider's own wire format directly, so it
// doesn't care which one is running underneath.
import type { ToolDef } from "./tools.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: {
    function: { name: string; arguments: Record<string, unknown> };
    /**
     * A backend's own opaque per-call metadata, round-tripped back to
     * that same backend unchanged on the next turn -- needed for
     * Gemini specifically, whose API rejects a reconstructed
     * functionCall that's missing the `thoughtSignature` it returned
     * the first time (confirmed directly: a real 400 "Function call is
     * missing a thought_signature" error). Other backends (Ollama)
     * never set or read this.
     */
    raw?: unknown;
  }[];
  /** Which tool this result is for, on a "tool"-role message -- Ollama doesn't need it (matches by array order), Gemini's functionResponse does (matches by name). */
  name?: string;
}

export interface ChatBackend {
  name: string;
  /**
   * One turn: given the full message history and the tools available,
   * returns the model's reply (content and/or tool_calls). `onPartial`,
   * if the backend supports streaming, is called repeatedly with the
   * accumulated text-so-far.
   */
  chat(messages: ChatMessage[], tools: ToolDef[], onPartial?: (textSoFar: string) => void): Promise<ChatMessage>;
}
