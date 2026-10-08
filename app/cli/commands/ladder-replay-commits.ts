// `zz ladder replay-commits <owner/repo> [--limit N]`: walks the commit
// log from the root commit forward, one Lane per commit, building a
// changeset rung (with nested filechange/linechange rungs) for each and
// merging it into the repo's Ladder -- the historical changelog, as
// opposed to `ladder-build.ts`'s snapshot-at-HEAD file tree and GitHub
// metadata. Run `zz ladder build` first: this expects a file rung to
// already exist for files it updates (it won't create one from
// scratch, to avoid re-deriving the whole current-state tree here too).
import { ensureCloned, resolveRepo } from "../lib/repo.js";
import { commitFileChanges, fileContentAtCommit, listCommitsChronological, type CommitRow, type FileChangeRow } from "../../engine/ingest.js";
import { resolveModelBackend, type ModelBackend } from "../../engine/model.js";
import { ask, answer, mergeLaneLadder, proposeLane, requestRungUpdate } from "../../engine/lane.js";
import type { Rung } from "../../engine/ladder.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { readAnchor, writeLadder } from "../../engine/ladderNotes.js";
import { readLane } from "../../engine/store.js";
import type { LaneRef } from "../../engine/types.js";

export interface ReplayOptions {
  limit?: number;
  force?: boolean;
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 25;

function mechanicalFileChangeRung(commit: CommitRow, change: FileChangeRow, fileCount: number): Rung {
  const note = change.status === "modified" ? `modified, ${change.hunks.length} hunk(s)` : change.status;
  return { path: change.path, kind: "filechange", summary: `${note}, as part of a ${fileCount}-file commit described at the commit level only.`, sources: [{ kind: "commit", ref: commit.sha, title: commit.message, author: commit.author, at: commit.at }], children: [] };
}

const AGENT = process.env.ZZ_AGENT ?? "zz-local";
// A distinct name for the coordinator side of the protocol, even though
// one local model plays both parts in this bootstrap -- per the project's
// own framing, every actor (human or agent) is a client of the same
// protocol, and that includes "the coordinator" as a named party, not an
// implicit system behavior.
const COORDINATOR = process.env.ZZ_COORDINATOR ?? "zz-coordinator";

async function isPresent(repoDir: string, stateDir: string, path: string): Promise<boolean> {
  return (await readAnchor(repoDir, stateDir, path)) !== null;
}

async function describeHunk(model: ModelBackend, path: string, hunk: string): Promise<string> {
  const described = await model.summarize(
    `Describe in one sentence what changed in this diff hunk from ${path}. Name the specific functions/identifiers added, removed, or changed. No caveats, no markdown.\n\n${hunk}\n---\nSummary:`,
  );
  return described ?? `change at ${hunk.split("\n")[0]}`;
}

async function buildFileChangeRung(model: ModelBackend, repoDir: string, commit: CommitRow, change: FileChangeRow): Promise<Rung> {
  if (change.status === "added") {
    const content = fileContentAtCommit(repoDir, commit.sha, change.path);
    const described = content.trim()
      ? (await model.summarize(`Describe in 1-2 sentences what this newly-added file contains.\n\nFile: ${change.path}\n---\n${content.slice(0, 6000)}\n---\nSummary:`)) ?? "new file."
      : "new empty file.";
    return { path: change.path, kind: "filechange", summary: `added. ${described}`, sources: [{ kind: "commit", ref: commit.sha, title: commit.message, author: commit.author, at: commit.at }], children: [] };
  }
  if (change.status === "deleted") {
    return { path: change.path, kind: "filechange", summary: "deleted.", sources: [{ kind: "commit", ref: commit.sha, title: commit.message, author: commit.author, at: commit.at }], children: [] };
  }
  const lineRungs: Rung[] = [];
  for (const hunk of change.hunks) {
    const header = hunk.split("\n")[0];
    const described = await describeHunk(model, change.path, hunk);
    lineRungs.push({ path: `${change.path}${header}`, kind: "linechange", summary: described, sources: [], children: [] });
  }
  const overview = change.hunks.length
    ? (await model.summarize(`Describe in one sentence the overall effect of this commit's changes to ${change.path}, based on the ${change.hunks.length} hunk(s) below.\n\n${change.hunks.join("\n\n")}\n---\nSummary:`)) ?? `modified, ${change.hunks.length} hunk(s).`
    : "modified.";
  return { path: change.path, kind: "filechange", summary: overview, sources: [{ kind: "commit", ref: commit.sha, title: commit.message, author: commit.author, at: commit.at }], children: lineRungs };
}

/** The coordinator's own current-state file rung, kept up to date as changesets land -- distinct from the filechange rungs above, which are this one commit's historical record. Only updates an existing anchor (created by `ladder build`'s file-tree pass); doesn't create one from scratch, to avoid re-deriving tree attachment here too. */
async function updateCurrentFileRung(repoDir: string, stateDir: string, laneId: string, commit: CommitRow, change: FileChangeRow, changeSummary: string): Promise<void> {
  const existing = await readAnchor(repoDir, stateDir, change.path);
  if (!existing) return; // not in the current tree (e.g. later deleted before HEAD); known gap, see file header.
  if (existing.children.length > 0) return; // has nested (e.g. hand-researched function/line) children this pass can't safely preserve; leave it alone rather than risk dropping them.
  // Keep only one level of "previously" -- strip any prior one already
  // baked into the existing summary, so this doesn't grow into an
  // ever-longer chain across however many commits touch this file. The
  // full history is what the filechange rungs in each changeset are for;
  // this rung is a snapshot, not an archive.
  const previousClean = existing.summary.replace(/ \(previously:.*\)$/s, "");
  await requestRungUpdate(stateDir, laneId, { from: AGENT, ref: change.path }, async () => {
    const updated: Rung = {
      path: existing.path,
      kind: existing.kind,
      summary: `${changeSummary} (previously: ${previousClean})`,
      sources: [{ kind: "commit", ref: commit.sha, title: commit.message, author: commit.author, at: commit.at }, ...existing.sources].slice(0, 5),
      touches: existing.touches,
      children: [], // `file` rungs have no nested children of their own kind; the parameter here is always [].
    };
    await writeLadder(repoDir, stateDir, updated);
  });
}

export async function ladderReplayCommits(slug: string, options: ReplayOptions): Promise<void> {
  const repo = resolveRepo(slug);
  ensureCloned(repo);
  const model = await resolveModelBackend();
  console.error(`model backend: ${model.name}`);

  let repoLane = readLane(repo.stateDir, REPO_RUNG_PATH);
  if (!repoLane) {
    repoLane = proposeLane(repo.stateDir, { id: REPO_RUNG_PATH, repo: slug, name: slug, objective: `the ${slug} repository`, scope: ["**"], proposedBy: COORDINATOR });
    const review = ask(repo.stateDir, repoLane.id, { kind: "review_request", from: COORDINATOR });
    answer(repo.stateDir, repoLane.id, review, { from: COORDINATOR, action: "grant" });
  }
  const origin: LaneRef = { repo: slug, lane: repoLane.id };

  const commits = listCommitsChronological(repo.repoDir);
  const limit = options.limit ?? commits.length;
  let processed = 0;
  let skipped = 0;

  for (const commit of commits) {
    if (processed >= limit) break;
    const laneId = `commit-${commit.sha.slice(0, 10)}`;
    const path = `changesets/${commit.sha}`;
    if (!options.force && (await isPresent(repo.repoDir, repo.stateDir, path))) {
      skipped += 1;
      continue;
    }

    // The coordinator files the task; the actor claims it.
    const lane = proposeLane(repo.stateDir, { id: laneId, repo: slug, name: `replay commit ${commit.sha.slice(0, 7)}`, objective: commit.message, scope: [path], origin, proposedBy: COORDINATOR, reason: commit.message });
    const claim = ask(repo.stateDir, lane.id, { kind: "claim_request", from: AGENT, ref: commit.sha });
    answer(repo.stateDir, lane.id, claim, { from: COORDINATOR, action: "grant", ref: commit.sha });

    const changes = commitFileChanges(repo.repoDir, commit);
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const large = changes.length > maxFiles;
    console.error(`[${processed + 1}/${limit}] ${commit.sha.slice(0, 7)} "${commit.message}" -- ${changes.length} file(s)${large ? " (large commit: mechanical only)" : ""}`);

    const fileChangeRungs: Rung[] = [];
    for (const change of changes) {
      const rung = large ? mechanicalFileChangeRung(commit, change, changes.length) : await buildFileChangeRung(model, repo.repoDir, commit, change);
      fileChangeRungs.push(rung);
      // A separate, non-blocking round trip per file: the actor asks the
      // coordinator to fold this change into the file's current-state
      // rung, which is shared across every changeset that touches it.
      // Skipped for large commits too -- the mechanical summary isn't
      // worth propagating into the file's current-state rung.
      if (!large) await updateCurrentFileRung(repo.repoDir, repo.stateDir, lane.id, commit, change, rung.summary);
    }

    const changesetRung: Rung = {
      path,
      kind: "changeset",
      summary: `${commit.message} (${commit.author}, ${commit.at}). ${changes.length} file(s) changed.${large ? " A large commit; files described at a glance, not individually." : ""}`,
      sources: [{ kind: "commit", ref: commit.sha, title: commit.message, author: commit.author, at: commit.at }],
      children: fileChangeRungs,
    };

    const mergeRequest = ask(repo.stateDir, lane.id, { kind: "merge_request", from: AGENT, ref: commit.sha });
    answer(repo.stateDir, lane.id, mergeRequest, { from: COORDINATOR, action: "grant", ref: commit.sha });
    const merged = readLane(repo.stateDir, lane.id)!;
    await mergeLaneLadder(repo.repoDir, repo.stateDir, merged, changesetRung);

    processed += 1;
  }

  console.error(`done: ${processed} commits replayed, ${skipped} already onboarded, ${commits.length - processed - skipped} remaining.`);
}
