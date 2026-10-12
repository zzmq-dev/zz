// Thin authenticated-fetch wrapper over the Worker's /api/* JSON layer
// (webApp.ts) -- every zz CLI command that touches the remote backend
// goes through this, same auth model the git proxy and the web app
// itself use (bearer token -> resolveRequestAgent).
import { apiBase, requireCredentials } from "./credentials.js";

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Set once, near the top of a remote command (work/review/repo submit)
// after resolveIdentity() -- everything downstream (callRemoteTool,
// the remote Backend, every plain apiFetch call) picks it up without
// needing a token threaded through every function signature in
// between. A per-call `tokenOverride` still wins when given; falling
// through to requireCredentials() keeps every existing direct
// apiFetch call (zz repo create/grant/clone, zz agent list, ...)
// working exactly as before for commands that never touch identity.ts.
let activeToken: string | null = null;
export function setActiveToken(token: string): void {
  activeToken = token;
}

export async function apiFetch<T>(method: "GET" | "POST", path: string, body?: unknown, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? activeToken ?? requireCredentials().token;
  const resp = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new ApiRequestError(resp.status, (data as { error?: string }).error ?? `request failed: ${resp.status}`);
  return data as T;
}
