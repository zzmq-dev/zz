// `zz ladder push <local-repo> <owner/repo>`: the one-time transfer
// half of importing a real GitHub repo into zz's own remote backend.
// All the actual work -- fetching issues/PRs/releases/contributors,
// summarizing every file, resolving tag commits -- already happened
// locally via `zz ladder build` (fast, reliable, no network round
// trip per item, no exposure to the remote Ladder's own documented
// read-after-write consistency gap for a brand-new ref -- see
// cloudflareLadderBackend.ts's own comment on readRung). This command
// just replays what's already sitting in the local clone's git notes
// onto a real remote repo: the git history (a real push) and every
// Ladder rung (one ladder_write_rung call per anchor, sourced directly
// from the local notes -- no model calls, no GitHub API calls here).
import { execFileSync } from "node:child_process";
import { resolveRepo } from "../lib/repo.js";
import { readAnchor, type EmbeddedRung } from "../../engine/ladderNotes.js";
import { remoteCallTool } from "../lib/remoteTools.js";
import { authedCloneUrl, requireCredentials } from "../lib/credentials.js";

interface FlatAnchor {
  path: string;
  rung: EmbeddedRung;
}

// Starting from "_repo", follows every ref (an anchor's own children
// list mixes embedded non-anchor content with {ref: path} entries for
// nested anchors -- a directory's own files, for instance) and reads
// each one's already-written note directly off the local clone. This
// is exactly the shape writeLadder (engine/ladderNotes.ts) originally
// split the tree into when `zz ladder build` wrote it in the first
// place, so there's no re-deriving anything here, just reading it back
// node by node.
async function collectAnchors(repoDir: string, stateDir: string, path: string, out: FlatAnchor[], seen: Set<string>): Promise<void> {
  if (seen.has(path)) return;
  seen.add(path);
  const rung = await readAnchor(repoDir, stateDir, path);
  if (!rung) return;
  out.push({ path, rung });
  for (const child of rung.children) {
    if ("ref" in child) await collectAnchors(repoDir, stateDir, child.ref, out, seen);
  }
}

export async function ladderPush(sourceSlug: string, targetSlug: string): Promise<void> {
  const source = resolveRepo(sourceSlug);
  const identity = requireCredentials();

  console.error(`pushing ${sourceSlug}'s real git history to ${targetSlug}...`);
  const cloneUrl = authedCloneUrl(identity.apiBase, identity.token, targetSlug);
  // --force: the target was just created with its own single bootstrap
  // commit (doCreateRepo's seed README/LICENSE), unrelated history to
  // the real repo being imported -- this replaces it wholesale, which
  // is exactly what importing an existing project into a freshly
  // created target means.
  execFileSync("git", ["-C", source.repoDir, "push", "--force", cloneUrl, "HEAD:main"], { stdio: "inherit" });
  const rootCommit = execFileSync("git", ["-C", source.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  console.error("collecting the local Ladder...");
  const anchors: FlatAnchor[] = [];
  await collectAnchors(source.repoDir, source.stateDir, "_repo", anchors, new Set());
  console.error(`found ${anchors.length} rung(s) to push`);

  let done = 0;
  for (const { rung } of anchors) {
    // "repo"/"directory" have no commit source locally (writeLadder
    // never needed one -- see its own anchor-by-kind comment), but the
    // remote write validates one for every structural-anchor kind
    // (agent/tools.ts's RUNG_KINDS_NEEDING_A_COMMIT_SOURCE). The real,
    // just-pushed root commit is a correct anchor for both: neither
    // kind is tied to one specific commit, which is exactly why the
    // remote Ladder backend roots them to a fixed point instead of a
    // blob (cloudflareLadderBackend.ts's own ROOT_ANCHORED_KINDS).
    const sources = rung.sources.length ? rung.sources : (rung.kind === "repo" || rung.kind === "directory" ? [{ kind: "commit" as const, ref: rootCommit, title: "onboarded via zz ladder build/push", author: "zz-local", at: new Date().toISOString() }] : rung.sources);
    // ladder_write_rung expects real, fully-embedded Rung objects as
    // children (or none) -- never the {ref: path} shorthand the local
    // notes store uses for an anchor's own already-written children
    // (confirmed live: sending "_repo"'s own stored ref list this way
    // got coerced into garbage empty rungs and rejected for an empty
    // summary/path). "_repo" is the only rung here that ever has
    // children at all (every other kind is a leaf, by construction of
    // how zz ladder build writes them) -- strip them and let
    // mergeLaneLadder's own appendRepoChildren (triggered automatically
    // by every other push below) rebuild the real list incrementally,
    // the same way the original local build did it one item at a time.
    const children = rung.path === "_repo" ? [] : rung.children;
    await remoteCallTool("ladder_write_rung", { repo: targetSlug, rung: { path: rung.path, kind: rung.kind, summary: rung.summary, sources, children } });
    done += 1;
    if (done % 10 === 0 || done === anchors.length) console.error(`  pushed ${done}/${anchors.length}`);
  }
  console.error("done.");
}
