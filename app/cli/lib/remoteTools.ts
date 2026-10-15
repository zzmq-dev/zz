// Calls a single tool by name against a deployed Worker's MaintainerDO,
// via the generic /api/repos/:owner/:repo/tools/:name passthrough
// (app/worker/src/webApp.ts's handleApiCallTool). This is the one
// mechanism "remote zz work" is built on: the exact same tool code
// (agent/tools.ts's ALL_TOOLS) runs server-side either way, so there's
// no separate remote reimplementation of any protocol logic to drift
// out of sync with the local path.
import { apiFetch } from "./api.js";
import { resolveMe } from "./credentials.js";
import type { ToolDef } from "../../agent/tools.js";

export function splitSlug(slug: string): [string, string] {
  slug = resolveMe(slug);
  const idx = slug.lastIndexOf("/");
  if (idx === -1) throw new Error(`expected "owner/repo-name", got "${slug}"`);
  return [slug.slice(0, idx), slug.slice(idx + 1)];
}

/** `allowAnonymous`: for the handful of read-only tools the server itself allows with no auth on a public repo (webApp.ts's ANON_READ_TOOLS -- today just lane_list/ladder_tree) -- without this, apiFetch throws locally via requireCredentials() before a request claiming to need no login ever reaches the network. Every other caller (ask_claim, ask_answer, commit_changeset, ...) leaves this false, unchanged: those always need a real identity, and the server would 401 an anonymous call anyway. */
export async function callRemoteTool(repoSlug: string, name: string, args: Record<string, unknown>, allowAnonymous = false): Promise<unknown> {
  const [owner, repo] = splitSlug(repoSlug);
  const { result } = await apiFetch<{ result: unknown }>("POST", `/api/repos/${owner}/${repo}/tools/${name}`, args, undefined, allowAnonymous);
  return result;
}

// A generic ProtocolCall/executeTool implementation, repo-agnostic --
// every tool's own arguments already carry `repo` (the model always
// supplies it; scriptedWork.ts's own call sites always do too), so
// these just forward whichever repo the call actually names instead
// of needing one supplied separately. Drop-in for agent/loop.ts's
// `executeTool` option and agent/scriptedWork.ts's `callTool` option.
export async function remoteCallTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const repo = args.repo as string | undefined;
  if (!repo) throw new Error(`tool "${name}" call is missing a "repo" argument`);
  return callRemoteTool(repo, name, args);
}

export async function remoteExecuteTool(tool: ToolDef, args: Record<string, unknown>): Promise<unknown> {
  return remoteCallTool(tool.name, args);
}
