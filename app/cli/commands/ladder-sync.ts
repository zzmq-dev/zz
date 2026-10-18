// `zz ladder sync <local-repo> <owner/repo>`: keeps an already-imported
// zz repo in sync with ongoing changes to its real GitHub source --
// the ongoing half of onboarding, where `zz ladder build` + `zz
// ladder push` (cli/commands/ladder-push.ts) was the one-time half.
//
// Re-summarizes only files that actually changed since the last sync
// (describeOneFile, engine/ingest.ts -- not a full re-walk of every
// file, which is what makes this "incremental" rather than just
// re-running the full build). Issues/PRs/releases/contributors/
// dependencies are NOT diffed at all here: ladder-build.ts's own
// buildAskFromIssue/buildAskFromPr/buildRelease/buildContributor/
// buildDependency each already check isPresent first and skip
// anything already onboarded, so calling all of them again, every
// time, is already exactly as incremental as this file's own diffing
// -- just for free, with no extra bookkeeping needed for any of those
// five kinds.
//
// KNOWN LIMITATION: a brand-new file (one that didn't exist at the
// last sync) gets written and registered under the repo root's own
// children list -- mergeLaneLadder's own appendRepoChildren call does
// this automatically for any top-level write, same as every other
// kind onboarded here -- but NOT nested under its real parent
// directory's own note the way ladder-build.ts's initial full walk
// nests it (appendRepoChildren only ever targets the repo root, not
// an arbitrary directory; generalizing that is a bigger change than
// this first pass takes on). The file's content and summary are still
// correctly stored and findable by path and by search either way; it
// just won't show up when browsing into that directory in the Ladder
// tree view. Re-run `zz ladder build --force` (a full, expensive
// re-walk) if that gap matters for a given repo.
//
// Deletions are detected (git diff's own "D" status) but not acted on
// at all -- there's no delete primitive for a rung yet. Printed as a
// warning so they're not silently lost from view, not auto-removed.
import { execFileSync } from "node:child_process";
import { resolveRepo, fetchClone, ensureWorktree, removeWorktree } from "../lib/repo.js";
import { fetchContributors, fetchIssues, fetchPullRequests, fetchReleases, parseDependencies, describeOneFile } from "../../engine/ingest.js";
import { resolveModelBackend } from "../../engine/model.js";
import type { Provider } from "../lib/resolveChatBackend.js";
import { readSyncState, writeSyncState } from "../lib/syncState.js";
import { resolveMe } from "../lib/credentials.js";
import { runItemLane, resolveRepoLaneOrigin, buildAskFromIssue, buildAskFromPr, buildRelease, buildContributor, buildDependency } from "./ladder-build.js";
import { ladderPush } from "./ladder-push.js";

export interface SyncOptions {
  provider?: Provider;
  model?: string;
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
}

export async function ladderSync(sourceSlug: string, targetSlug: string, options: SyncOptions): Promise<void> {
  // sourceSlug is a GitHub "owner/repo", not a zz account -- @me means
  // nothing there. targetSlug is the real zz-hosted destination.
  targetSlug = resolveMe(targetSlug);
  const base = resolveRepo(sourceSlug);
  const model = await resolveModelBackend(options.provider, options.model);
  console.error(`model backend: ${model.name}`);

  console.error(`fetching ${sourceSlug}'s real GitHub source...`);
  fetchClone(base);
  // Isolated worktree, not the shared base clone's own working tree --
  // this reads/diffs real file content below (git diff, describeOneFile,
  // parseDependencies), which needs a working tree that actually matches
  // the fetched HEAD, and a worktree is what keeps that safe if a `zz
  // work` process is concurrently doing the same against this repo.
  const repo = ensureWorktree(base, "origin/main");
  try {
  const head = git(repo.repoDir, ["rev-parse", "HEAD"]);
  const origin = await resolveRepoLaneOrigin(repo.slug, repo.stateDir);

  const state = readSyncState(repo.stateDir);
  if (!state) {
    console.error("no previous sync baseline on this clone (run `zz ladder push` at least once first -- it records one). Treating the entire current file tree as changed.");
  }

  if (state?.lastSyncedCommit === head) {
    console.error("no new commits since the last sync.");
  } else {
    const diffLines = state
      ? git(repo.repoDir, ["diff", "--name-status", state.lastSyncedCommit, head])
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("\t") as [string, string])
      : git(repo.repoDir, ["ls-tree", "-r", "--name-only", "HEAD"])
          .split("\n")
          .filter(Boolean)
          .map((p): [string, string] => ["A", p]);

    const changed = diffLines.filter(([status]) => status === "A" || status === "M");
    const deleted = diffLines.filter(([status]) => status === "D").map(([, path]) => path);
    if (deleted.length > 0) {
      console.error(`${deleted.length} file(s) deleted since the last sync -- NOT removed from the Ladder (no delete primitive exists for a rung yet): ${deleted.slice(0, 10).join(", ")}${deleted.length > 10 ? ", ..." : ""}`);
    }

    console.error(`${changed.length} file(s) added or changed -- re-summarizing...`);
    let done = 0;
    for (const [status, path] of changed) {
      // A brand-new file (or the first sync ever, with no baseline to
      // diff against at all) has nothing existing to fold a change
      // into -- describing what it holistically does is the right
      // (and only sensible) summary there, same as a fresh `zz ladder
      // build` would write. A genuinely MODIFIED file is different:
      // describeOneFile's own default prompt re-describes the WHOLE
      // file from scratch, independent of whatever's already stored
      // remotely -- fold-in (ladder_write_rung's own, unconditional,
      // unchanged here) then has to reconcile two independently-
      // generated full descriptions of the same file with no "this is
      // what's new" framing to work from. Confirmed live: across a
      // handful of repeated builds+pushes, that produced the same
      // paragraph restated three times with minor rewording each
      // round, not a clean merge. Describing just the diff instead --
      // what a changeset's own filechange rung already does for the
      // live agent protocol's commits -- gives fold-in an actual
      // change to incorporate into the existing holistic summary,
      // which is the whole reason it exists.
      const isModified = status === "M" && state;
      await runItemLane(repo.repoDir, repo.stateDir, { id: `resync-${path}`, repo: repo.slug, name: `re-sync ${path}`, objective: path, scope: [path], origin }, () =>
        describeOneFile(repo.repoDir, path, async (p, content, mechanical) => {
          if (!content.trim()) return mechanical;
          if (!isModified) {
            const described = await model.summarize(`Describe in 1-3 sentences what this file does, based on its content below. Name exported functions/classes by name.\n\nFile: ${p}\n---\n${content.slice(0, 6000)}\n---\nSummary:`);
            return described ?? mechanical;
          }
          const diffText = execFileSync("git", ["-C", repo.repoDir, "diff", "--unified=2", state!.lastSyncedCommit, head, "--", p], { encoding: "utf8" });
          const described = await model.summarize(`Describe in 1-2 sentences what changed in this diff -- the change itself, not what the whole file does now. Name any function/export added, removed, or modified.\n\nFile: ${p}\n---\n${diffText.slice(0, 4000)}\n---\nWhat changed:`);
          return described ?? mechanical;
        }),
      );
      done += 1;
      if (done % 5 === 0) console.error(`  files: ${done}/${changed.length}`);
    }
  }

  console.error("checking for new issues, PRs, releases, contributors, dependencies (already-onboarded ones are skipped automatically)...");
  const issues = fetchIssues(repo.slug);
  const prs = fetchPullRequests(repo.slug);
  const releases = fetchReleases(repo.slug);
  const contributors = fetchContributors(repo.slug);
  const dependencies = parseDependencies(repo.repoDir);

  for (const i of issues) await buildAskFromIssue(repo.repoDir, repo.stateDir, origin, repo.slug, model, i);
  for (const p of prs) await buildAskFromPr(repo.repoDir, repo.stateDir, origin, repo.slug, model, p);
  for (const r of releases) await buildRelease(repo.repoDir, repo.stateDir, origin, repo.slug, r);
  for (const c of contributors) await buildContributor(repo.repoDir, repo.stateDir, origin, repo.slug, model, c);
  for (const d of dependencies) await buildDependency(repo.repoDir, repo.stateDir, origin, repo.slug, model, d.name, d.versionRange);

  writeSyncState(repo.stateDir, head);

  console.error(`pushing the updated Ladder to ${targetSlug}...`);
  // Reuses ladderPush wholesale rather than pushing only the rungs
  // that changed this run -- every rung gets re-sent, not just the
  // ones touched above, so a sync costs roughly the same as a fresh
  // push regardless of how little actually changed. Correct (each
  // write is a plain overwrite, so re-sending unchanged content is
  // harmless) and simple, at the cost of not being maximally cheap --
  // an acceptable trade for a first version now that writeRungsBatch
  // makes even a full push fast (~240 rungs in under 2 minutes, not
  // the multi-hour cost a naive per-rung push used to have).
  //
  // markIngesting: false -- this is a routine update to an
  // already-ready repo, not the one-time initial import, so it
  // shouldn't disappear from search while it runs (see
  // ladder-push.ts's own comment on the option).
  await ladderPush(sourceSlug, targetSlug, { markIngesting: false });
  console.error("sync done.");
  } finally {
    removeWorktree(base, repo);
  }
}
