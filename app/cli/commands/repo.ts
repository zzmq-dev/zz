// `zz repo create/grant/list/ask` -- CLI parity with /profile's repo
// management and the explore page's search. Same JSON API the web
// app's own forms call (webApp.ts's doCreateRepo/doRbacGrant/doPostAsk),
// so behavior (including the "push needs Maintainer+" RBAC rule) is
// identical regardless of which surface you used.
import { apiFetch } from "../lib/api.js";

interface RepoRow {
  id: string;
  slug: string;
  artifacts_name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export async function repoCreate(name: string, opts: { description?: string; ownerId?: string }): Promise<void> {
  const repo = await apiFetch<RepoRow>("POST", "/api/repos", { name, description: opts.description, owner_id: opts.ownerId });
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

function splitSlug(slug: string): [string, string] {
  const idx = slug.lastIndexOf("/");
  if (idx === -1) throw new Error(`expected "owner/repo-name", got "${slug}"`);
  return [slug.slice(0, idx), slug.slice(idx + 1)];
}
