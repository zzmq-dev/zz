// `zz lane create/grant/list/checkout/delete` -- CLI parity with
// /profile's Lanes card and the Explore page's search. Same JSON API
// the web app's own forms call (webApp.ts's doCreateRepo/doRbacGrant),
// so behavior (including the "push needs Coordinator+" RBAC rule) is
// identical regardless of which surface you used. `repo ask`/`asks`
// retired (#43) in favor of `zz ask post`/`zz ask list`, which work on
// any Lane, not just the origin one these two always assumed.
//
// A repo is still the real backing store underneath every Lane --
// that's a technical fact about how storage works, not something a
// person using this CLI needs to think in terms of. "repo" stays out
// of every command name, flag, and printed message here; `checkout`
// (not `clone`) is the one command that's genuinely a git operation,
// per #43's own naming rationale ("checkout" never means "create a
// new thing" in git vocabulary, unlike "clone").
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { apiFetch, setActiveToken } from "../lib/api.js";
import { requireCredentials, resolveMe } from "../lib/credentials.js";
import { resolveIdentity, releaseIdentity, expandAgentId } from "../lib/identity.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { Lane } from "../../engine/types.js";

interface RepoRow {
  slug: string;
  artifacts_name: string;
  description: string | null;
  owner_username: string;
  created_at: string;
  updated_at: string;
}

export interface LaneCreateOptions {
  description?: string;
  /** Standalone case only (no <owner/lane>, no --from): the owning Agent's username. */
  ownerUsername?: string;
  /** Forks a new, independent Lane from this existing one instead of starting from scratch -- mutually exclusive with the <owner/lane> positional (#59). */
  from?: string;
  /** Sets the new Lane's own origin pointer -- always that other Lane's own origin, not an arbitrary non-origin one (lane_propose's own origin_lane/origin_repo params still exist directly for that finer-grained case). Valid with <owner/lane> or --from, not with neither. */
  origin?: string;
  /** <owner/lane> case only: comma-separated agent ids -- defaults to just you if omitted. */
  committee?: string;
  /** <owner/lane> case only: explicit lane id -- omit for a generated one. */
  id?: string;
  as?: string;
}

/**
 * #59: one command, three underlying shapes, picked by which of
 * `laneArg`/`opts.from` is given -- replaces the old separate `zz
 * lane propose` entirely (folded in here, not kept alongside it).
 *
 * - Neither given: today's original behavior, unchanged -- a brand
 *   new, standalone Lane (its own fresh repo, no relation to anything
 *   else).
 * - `laneArg` (<owner/lane>) given: an ordinary Lane inside that
 *   EXISTING one's own repo -- no new repo at all. Goes through the
 *   lane_propose tool directly (callRemoteTool), same as the old `zz
 *   lane propose` did.
 * - `opts.from` given: a new, independent Lane forked from that
 *   existing one's own repo (doForkRepo, webApp.ts) -- the explicit,
 *   user-named counterpart to claiming a work Ask into its own shard.
 */
export async function laneCreate(name: string, laneArg: string | undefined, opts: LaneCreateOptions): Promise<void> {
  if (laneArg && opts.from) throw new Error("<owner/lane> and --from can't both be given -- pick one place for this Lane to come from.");
  if (opts.ownerUsername && (laneArg || opts.from)) throw new Error("--owner only applies when creating a new, standalone Lane (no <owner/lane>, no --from).");
  if (opts.origin && !laneArg && !opts.from) throw new Error("--origin needs either an existing <owner/lane> or --from to attach to.");

  if (laneArg) {
    const slug = resolveMe(laneArg);
    const identity = await resolveIdentity({ as: opts.as });
    setActiveToken(identity.token);
    try {
      let originLane: string | undefined;
      let originRepo: string | undefined;
      if (opts.origin) {
        const originSlug = resolveMe(opts.origin);
        const { repo } = await apiFetch<{ repo: RepoRow }>("GET", `/api/repos/${originSlug}`);
        originLane = "origin";
        originRepo = repo.artifacts_name;
      }
      const committee = opts.committee ? opts.committee.split(",").map((s) => expandAgentId(s.trim())) : undefined;
      const lane = (await callRemoteTool(slug, "lane_propose", {
        name,
        objective: opts.description ?? name,
        scope: ["**"],
        actor: identity.username,
        id: opts.id,
        committee,
        origin_lane: originLane,
        origin_repo: originRepo,
      })) as Lane;
      console.log(`Proposed Lane ${lane.id} in ${slug} -- coordinators: [${lane.coordinators.join(", ")}], committee: [${lane.committee.join(", ")}]`);
    } finally {
      await releaseIdentity(identity);
    }
    return;
  }

  const identity = await resolveIdentity({ as: opts.as });
  setActiveToken(identity.token);
  try {
    const repo = await apiFetch<RepoRow>("POST", "/api/repos", {
      name,
      description: opts.description,
      owner_username: opts.ownerUsername,
      from: opts.from ? resolveMe(opts.from) : undefined,
      origin: opts.origin ? resolveMe(opts.origin) : undefined,
    });
    console.log(`Created ${repo.slug}`);
  } finally {
    await releaseIdentity(identity);
  }
}

export async function laneList(query?: string): Promise<void> {
  const { repos } = await apiFetch<{ repos: RepoRow[] }>("GET", `/api/repos${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  if (repos.length === 0) {
    console.log(query ? "No matches." : "No Lanes yet.");
    return;
  }
  for (const r of repos) console.log(`${r.slug}${r.description ? ` -- ${r.description}` : ""}`);
}

// Irreversible (doDeleteRepo tears down the real backing store, not a
// soft-delete), so this asks you to type the name back rather than
// just a y/n -- same reasoning a real git host's own "delete this"
// confirmation uses, and cheap insurance against `--yes` muscle memory
// from some other CLI firing on the wrong one. Owner check happens
// server-side (doDeleteRepo); this only gates the prompt.
// #1: fork-promotion (promoteShardAsNewOrigin, webApp.ts) can hand a
// managed agent ownership of a real, independent Lane at any point --
// creating an agent grants its creator no Role on Lanes the agent
// later comes to own (Role/ownership and agent-management are
// separate systems). Without --as, the only way to act as that agent
// was a raw curl with a hand-minted token, bypassing this command's
// own confirm-by-typing-the-name safety prompt entirely. Same
// resolveIdentity/releaseIdentity pattern `zz work`/`zz review`
// already use: an --as token is minted fresh for this one call and
// revoked when it's done, never a standing credential.
export async function laneDelete(slug: string, opts: { yes?: boolean; as?: string } = {}): Promise<void> {
  slug = resolveMe(slug);
  const identity = await resolveIdentity({ as: opts.as });
  setActiveToken(identity.token);
  try {
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const typed = await rl.question(`This permanently deletes ${slug} -- real git history, Ladder, Lanes, all of it. Type the name to confirm: `);
      rl.close();
      if (typed.trim() !== slug) {
        console.error("Name didn't match -- not deleting anything.");
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

// Named access-grant, not grant, to stay distinct from `zz lane grant`
// (lane-grant.ts) -- that one adds a coordinator/committee member to
// one specific, already-proposed Lane; this one sets the origin-tier
// Role (owner/coordinator/contributor/viewer, #41) that every Lane in
// the whole thing inherits from.
export async function laneAccessGrant(slug: string, principal: string, role: string, opts: { as?: string } = {}): Promise<void> {
  slug = resolveMe(slug);
  principal = resolveMe(principal);
  const identity = await resolveIdentity({ as: opts.as });
  setActiveToken(identity.token);
  try {
    const [owner, name] = splitSlug(slug);
    await apiFetch("POST", `/api/repos/${owner}/${name}/roles`, { principal, role });
    console.log(`Granted ${principal} "${role}" on ${slug}.`);
  } finally {
    await releaseIdentity(identity);
  }
}

// #12: a credential helper (zz credential-helper, cli/commands/
// credential-helper.ts), not a token embedded in the clone URL -- the
// embedded-token form lived in .git/config's remote.origin.url in
// plaintext indefinitely (visible in `git remote -v`, copied wherever
// the directory is copied). `-c` scopes the helper to just this one
// `git clone` invocation (there's no .git/config yet to set it in
// permanently -- the directory doesn't exist until the checkout
// finishes); the config command right after persists the same,
// equally-non-secret helper *reference* (never a token itself) into
// the new checkout's own .git/config, so a later plain `git pull`/`git
// push` run outside the zz CLI entirely still gets a fresh credential
// transparently, no copy-paste into a Basic Auth prompt ever needed.
export async function laneCheckout(slug: string, dir?: string): Promise<void> {
  slug = resolveMe(slug);
  const creds = requireCredentials();
  const host = creds.apiBase.replace(/^https?:\/\//, "");
  const plainUrl = `${creds.apiBase}/${slug}`;
  const helperConfig = `credential.https://${host}.helper`;
  const args = ["-c", `${helperConfig}=!zz credential-helper`, "clone", plainUrl, ...(dir ? [dir] : [])];
  execFileSync("git", args, { stdio: "inherit" });
  const checkoutDir = dir ?? splitSlug(slug)[1];
  execFileSync("git", ["-C", checkoutDir, "config", helperConfig, "!zz credential-helper"], { stdio: "inherit" });

  // `zz lane submit` never pushes your local commit -- the coordinator
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
  execFileSync("git", ["-C", checkoutDir, "config", "pull.rebase", "true"], { stdio: "inherit" });

  // TEMPORARY, pending a Cloudflare fix -- a real bug in Artifacts'
  // own git-upload-pack, not anything zz ships: an incremental
  // fetch/pull with several commits to negotiate corrupts the
  // response ("fetch-pack: protocol error: bad band #78"), confirmed
  // live and root-caused in detail (see the case study link below).
  // `fetch.negotiationAlgorithm=noop` skips the "have"-line
  // negotiation entirely, which sidesteps it completely -- confirmed
  // live on the exact checkout that was reliably failing. Real
  // tradeoff: without negotiation, a fetch can't compute as small a
  // delta, so this likely transfers more data than a normal
  // incremental fetch would on a large, long-lived history. Once
  // Cloudflare fixes the underlying bug, remove this: delete the
  // block below, and tell existing checkouts to
  // `git config --unset fetch.negotiationAlgorithm`.
  execFileSync("git", ["-C", checkoutDir, "config", "fetch.negotiationAlgorithm", "noop"], { stdio: "inherit" });
}

function splitSlug(slug: string): [string, string] {
  slug = resolveMe(slug);
  const idx = slug.lastIndexOf("/");
  if (idx === -1) throw new Error(`expected "owner/name", got "${slug}"`);
  return [slug.slice(0, idx), slug.slice(idx + 1)];
}
