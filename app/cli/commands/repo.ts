// `zz repo create/grant/list/clone` -- CLI parity with /profile's repo
// management and the explore page's search. Same JSON API the web
// app's own forms call (webApp.ts's doCreateRepo/doRbacGrant), so
// behavior (including the "push needs Coordinator+" RBAC rule) is
// identical regardless of which surface you used. `repo ask`/`asks`
// retired (#43) in favor of `zz ask post`/`zz ask list`, which work on
// any Lane, not just the origin one these two always assumed.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { apiFetch, setActiveToken } from "../lib/api.js";
import { authedCloneUrl, requireCredentials, resolveMe } from "../lib/credentials.js";
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";

interface RepoRow {
  slug: string;
  artifacts_name: string;
  description: string | null;
  owner_username: string;
  created_at: string;
  updated_at: string;
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

// Irreversible (doDeleteRepo tears down the real Artifacts repo, not
// a soft-delete), so this asks you to type the slug back rather than
// just a y/n -- same reasoning a real git host's own "delete this
// repo" confirmation uses, and cheap insurance against `--yes` muscle
// memory from some other CLI firing on the wrong repo. Owner check
// happens server-side (doDeleteRepo); this only gates the prompt.
// #1: fork-promotion (promoteShardAsNewOrigin, webApp.ts) can hand a
// managed agent ownership of a real, independent repo at any point --
// creating an agent grants its creator no Role on repos the agent
// later comes to own (Role/ownership and agent-management are
// separate systems). Without --as, the only way to act as that agent
// was a raw curl with a hand-minted token, bypassing this command's
// own confirm-by-typing-the-slug safety prompt entirely. Same
// resolveIdentity/releaseIdentity pattern `zz work`/`zz review`
// already use: an --as token is minted fresh for this one call and
// revoked when it's done, never a standing credential.
export async function repoDelete(slug: string, opts: { yes?: boolean; as?: string } = {}): Promise<void> {
  slug = resolveMe(slug);
  const identity = await resolveIdentity(opts.as);
  setActiveToken(identity.token);
  try {
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const typed = await rl.question(`This permanently deletes ${slug} -- real git history, Ladder, Lanes, all of it. Type the repo slug to confirm: `);
      rl.close();
      if (typed.trim() !== slug) {
        console.error("Slug didn't match -- not deleting anything.");
        process.exitCode = 1;
        return;
      }
    }
    const [owner, name] = splitSlug(slug);
    await apiFetch("DELETE", `/api/repos/${owner}/${name}`);
    console.log(`Deleted ${slug}.`);
  } finally {
    await releaseIdentity(identity);
  }
}

export async function repoGrant(slug: string, principal: string, role: string, opts: { as?: string } = {}): Promise<void> {
  slug = resolveMe(slug);
  principal = resolveMe(principal);
  const identity = await resolveIdentity(opts.as);
  setActiveToken(identity.token);
  try {
    const [owner, name] = splitSlug(slug);
    await apiFetch("POST", `/api/repos/${owner}/${name}/roles`, { principal, role });
    console.log(`Granted ${principal} "${role}" on ${slug}.`);
  } finally {
    await releaseIdentity(identity);
  }
}


// Does the credential embedding manually instead of asking you to --
// the real reason this exists: the token-as-username convention is
// unfamiliar enough (confirmed live: the natural thing to type when
// git prompts "Username for ..." is your own identity, not a bearer
// token) that most people won't get it right by hand on the first try.
export async function repoClone(slug: string, dir?: string): Promise<void> {
  slug = resolveMe(slug);
  const creds = requireCredentials();
  const url = authedCloneUrl(creds.apiBase, creds.token, slug);
  const args = dir ? ["clone", url, dir] : ["clone", url];
  execFileSync("git", args, { stdio: "inherit" });

  // `zz repo submit` never pushes your local commit -- the coordinator
  // re-commits its exact file content server-side (commit_changeset),
  // as a new commit (a different sha, even for an identical diff) on
  // top of whatever the branch's current tip is. A later plain
  // `git pull` would then see your own local commit and the server's
  // as genuinely diverged (neither an ancestor of the other) and
  // either refuse (--ff-only) or stitch them together with a
  // pointless merge commit (the default). Rebase is the one mode that
  // comes out clean: git recognizes your local commit's patch is
  // already upstream (confirmed live: "skipped previously applied
  // commit") and drops it, leaving you fast-forwarded onto the real
  // merged commit with no extra history.
  const cloneDir = dir ?? splitSlug(slug)[1];
  execFileSync("git", ["-C", cloneDir, "config", "pull.rebase", "true"], { stdio: "inherit" });

  // TEMPORARY, pending a Cloudflare fix -- a real bug in Artifacts'
  // own git-upload-pack, not anything zz ships: an incremental
  // fetch/pull with several commits to negotiate corrupts the
  // response ("fetch-pack: protocol error: bad band #78"), confirmed
  // live and root-caused in detail (see the case study link below).
  // `fetch.negotiationAlgorithm=noop` skips the "have"-line
  // negotiation entirely, which sidesteps it completely -- confirmed
  // live on the exact clone that was reliably failing. Real
  // tradeoff: without negotiation, a fetch can't compute as small a
  // delta, so this likely transfers more data than a normal
  // incremental fetch would on a large, long-lived repo. Once
  // Cloudflare fixes the underlying bug, remove this: delete the
  // block below, and tell existing clones to
  // `git config --unset fetch.negotiationAlgorithm`.
  execFileSync("git", ["-C", cloneDir, "config", "fetch.negotiationAlgorithm", "noop"], { stdio: "inherit" });
}

function splitSlug(slug: string): [string, string] {
  slug = resolveMe(slug);
  const idx = slug.lastIndexOf("/");
  if (idx === -1) throw new Error(`expected "owner/repo-name", got "${slug}"`);
  return [slug.slice(0, idx), slug.slice(idx + 1)];
}
