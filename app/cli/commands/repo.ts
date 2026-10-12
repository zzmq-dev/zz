// `zz repo create/grant/list/ask/asks/clone` -- CLI parity with
// /profile's repo management and the explore page's search. Same JSON
// API the web app's own forms call (webApp.ts's doCreateRepo/
// doRbacGrant/doPostAsk), so behavior (including the "push needs
// Maintainer+" RBAC rule) is identical regardless of which surface
// you used.
import { execFileSync } from "node:child_process";
import { apiFetch } from "../lib/api.js";
import { authedCloneUrl, requireCredentials } from "../lib/credentials.js";

interface RepoRow {
  slug: string;
  artifacts_name: string;
  description: string | null;
  owner_username: string;
  created_at: string;
  updated_at: string;
}

interface LaneHistoryEntry {
  type: "ASK" | "ANSWER" | "INSIGHT";
  kind?: string;
  from?: string;
  action?: string;
  ask?: string;
  payload?: unknown;
  at: string;
}

export async function repoCreate(name: string, opts: { description?: string; ownerUsername?: string }): Promise<void> {
  const repo = await apiFetch<RepoRow>("POST", "/api/repos", { name, description: opts.description, owner_username: opts.ownerUsername });
  console.log(`Created ${repo.slug}`);
}

export async function repoList(query?: string): Promise<void> {
  const { repos } = await apiFetch<{ repos: RepoRow[] }>("GET", `/api/repos${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  if (repos.length === 0) {
    console.log(query ? "No matches." : "No repos yet.");
    return;
  }
  for (const r of repos) console.log(`${r.slug}${r.description ? ` -- ${r.description}` : ""}`);
}

export async function repoGrant(slug: string, principal: string, role: string): Promise<void> {
  const [owner, name] = splitSlug(slug);
  await apiFetch("POST", `/api/repos/${owner}/${name}/roles`, { principal, role });
  console.log(`Granted ${principal} "${role}" on ${slug}.`);
}

export async function repoAsk(slug: string, description: string): Promise<void> {
  const [owner, name] = splitSlug(slug);
  await apiFetch("POST", `/api/repos/${owner}/${name}/ask`, { description });
  console.log(`Posted to ${slug}'s root Lane.`);
}

export async function repoAsks(slug: string): Promise<void> {
  const [owner, name] = splitSlug(slug);
  const { lane } = await apiFetch<{ lane: { history: LaneHistoryEntry[] } | null }>("GET", `/api/repos/${owner}/${name}/asks`);
  const history = lane?.history ?? [];
  if (history.length === 0) {
    console.log("No Asks posted yet.");
    return;
  }
  for (const e of history) {
    if (e.type === "ASK") console.log(`[ASK] (${e.kind}) from ${e.from} -- ${JSON.stringify(e.payload)} @ ${e.at}`);
    else if (e.type === "ANSWER") console.log(`[ANSWER] ${e.action} by ${e.from} on ${e.ask} @ ${e.at}`);
    else console.log(`[INSIGHT] ${JSON.stringify(e.payload)} @ ${e.at}`);
  }
}

// Does the credential embedding manually instead of asking you to --
// the real reason this exists: the token-as-username convention is
// unfamiliar enough (confirmed live: the natural thing to type when
// git prompts "Username for ..." is your own identity, not a bearer
// token) that most people won't get it right by hand on the first try.
export async function repoClone(slug: string, dir?: string): Promise<void> {
  const creds = requireCredentials();
  const url = authedCloneUrl(creds.apiBase, creds.token, slug);
  const args = dir ? ["clone", url, dir] : ["clone", url];
  execFileSync("git", args, { stdio: "inherit" });
}

function splitSlug(slug: string): [string, string] {
  const idx = slug.lastIndexOf("/");
  if (idx === -1) throw new Error(`expected "owner/repo-name", got "${slug}"`);
  return [slug.slice(0, idx), slug.slice(idx + 1)];
}
