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
import { readAnchor, isRef, type EmbeddedRung, type EmbeddedRef } from "../../engine/ladderNotes.js";
import { remoteCallTool, splitSlug } from "../lib/remoteTools.js";
import { authedCloneUrl, requireCredentials } from "../lib/credentials.js";
import { apiFetch } from "../lib/api.js";

/** Owner-only (handleApiSetIngestStatus checks this server-side); targetSlug's owner is always whoever's logged in here, since `zz repo create` (run right before this, same identity) always creates under the caller unless --owner names someone else -- not this command's concern either way, the server enforces it regardless. */
async function setIngestStatus(targetSlug: string, status: "ready" | "ingesting"): Promise<void> {
  const [owner, name] = splitSlug(targetSlug);
  await apiFetch("POST", `/api/repos/${owner}/${name}/ingest-status`, { status });
}

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
    if (isRef(child)) await collectAnchors(repoDir, stateDir, child.ref, out, seen);
  }
}

// ladder_write_rung expects real, fully-embedded Rung objects as
// children -- never the {ref: path} shorthand the local notes store
// uses for a nested anchor (confirmed live: "_repo" AND every
// "directory" rung store their own file/subdirectory children this
// way, not just "_repo" -- a flat, no-subdirectory test repo never
// exposed this). Resolves every {ref} against the already-collected
// anchor map rather than re-reading notes, recursively, so a deeply
// nested directory's whole subtree round-trips through one write.
function embedChildren(rung: EmbeddedRung, byPath: Map<string, EmbeddedRung>): (EmbeddedRung | EmbeddedRef)[] {
  return rung.children.map((child) => {
    if (!isRef(child)) return child;
    const resolved = byPath.get(child.ref);
    if (!resolved) return child;
    return { ...resolved, children: embedChildren(resolved, byPath) };
  });
}

export async function ladderPush(sourceSlug: string, targetSlug: string): Promise<void> {
  const source = resolveRepo(sourceSlug);
  const identity = requireCredentials();

  // Left as "ingesting" (never reverted) if anything below throws --
  // an interrupted or failed push genuinely isn't ready, and that's
  // exactly the state a retry should start from too.
  await setIngestStatus(targetSlug, "ingesting");

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
  const byPath = new Map(anchors.map(({ path, rung }) => [path, rung]));

  // One ladder_write_rung call for every rung (ladder_write_rung's own
  // "rung" param accepts an array of top-level rungs), not one call
  // per rung -- confirmed live: at one HTTP round trip per rung, each
  // doing its own full git-notes fetch+push of an ever-growing shared
  // ref, 16 rungs alone took 13 minutes and climbing (a real O(n^2)
  // cost -- see cloudflareLadderBackend.ts's writeRungsBatch, the
  // server-side half of this same fix). Chunked rather than one giant
  // call, both for a saner request size and so a failure partway
  // through doesn't lose everything already confirmed sent.
  const BATCH_SIZE = 40;
  const payloads = anchors.map(({ rung }) => {
    // "repo"/"directory" have no commit source locally (writeLadder
    // never needed one -- see its own anchor-by-kind comment), but the
    // remote write validates one for every structural-anchor kind
    // (agent/tools.ts's RUNG_KINDS_NEEDING_A_COMMIT_SOURCE). The real,
    // just-pushed root commit is a correct anchor for both: neither
    // kind is tied to one specific commit, which is exactly why the
    // remote Ladder backend roots them to a fixed point instead of a
    // blob (cloudflareLadderBackend.ts's own ROOT_ANCHORED_KINDS).
    const sources = rung.sources.length ? rung.sources : (rung.kind === "repo" || rung.kind === "directory" ? [{ kind: "commit" as const, ref: rootCommit, title: "onboarded via zz ladder build/push", author: "zz-local", at: new Date().toISOString() }] : rung.sources);
    const children = embedChildren(rung, byPath);
    return { path: rung.path, kind: rung.kind, summary: rung.summary, sources, children };
  });

  let done = 0;
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE);
    await remoteCallTool("ladder_write_rung", { repo: targetSlug, rung: batch });
    done += batch.length;
    console.error(`  pushed ${done}/${payloads.length}`);
  }
  await setIngestStatus(targetSlug, "ready");
  console.error("done.");
}
