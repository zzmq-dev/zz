// `zz ladder replay-commits <owner/repo> [--limit N]`: walks the commit
// log from the root commit forward through a real work queue
// (engine/workqueue.ts), not a hand-written call sequence. One Lane per
// commit, each building a changeset rung (nested filechange/linechange
// rungs) and asking the repo Lane's own queue to merge it -- the repo
// Lane is the only thing that ever writes git notes, and only when it
// gets around to processing that ask, not when the commit-Lane finishes
// its own work. Run `zz ladder build` first: this expects a file rung to
// already exist for files it updates (it won't create one from
// scratch, to avoid re-deriving the whole current-state tree here too).
import { randomBytes } from "node:crypto";
import { ensureCloned, resolveRepo } from "../lib/repo.js";
import { commitFileChanges, fileContentAtCommit, listCommitsChronological, type CommitRow, type FileChangeRow } from "../../engine/ingest.js";
import { resolveModelBackend, type ModelBackend } from "../../engine/model.js";
import { ask, mergeLaneLadder, proposeLane } from "../../engine/lane.js";
import { runWorkerLoop } from "../../engine/workqueue.js";
import type { Rung } from "../../engine/ladder.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { readAnchor, writeLadder } from "../../engine/ladderNotes.js";
import { readLane } from "../../engine/store.js";
import type { AskEntry, LaneRef } from "../../engine/types.js";

export interface ReplayOptions {
  limit?: number;
  force?: boolean;
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 25;

// A distinct name for the coordinator side of the protocol, even though
// one local model plays both parts in this bootstrap -- per the
// project's own framing, every actor (human or agent) is a client of
// the same protocol, and that includes "the coordinator" as a named
// party, not an implicit system behavior.
const AGENT = process.env.ZZ_AGENT ?? "zz-local";
const COORDINATOR = process.env.ZZ_COORDINATOR ?? "zz-coordinator";

function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function isPresent(repoDir: string, stateDir: string, path: string): Promise<boolean> {
  return (await readAnchor(repoDir, stateDir, path)) !== null;
}

function mechanicalFileChangeRung(commit: CommitRow, change: FileChangeRow, fileCount: number): Rung {
  const note = change.status === "modified" ? `modified, ${change.hunks.length} hunk(s)` : change.status;
  return { path: change.path, kind: "filechange", summary: `${note}, as part of a ${fileCount}-file commit described at the commit level only.`, sources: [{ kind: "commit", ref: commit.sha, title: commit.message, author: commit.author, at: commit.at }], children: [] };
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

/**
 * Builds the updated current-state Rung for a file: a fresh synthesis of
 * its current description, not the old description with the latest
 * change tacked on. The model decides whether the change actually
 * matters -- a cosmetic change (formatting, whitespace, a rename with no
 * behavior change) shouldn't alter the description at all, let alone
 * read as if that cosmetic change were now the file's defining fact.
 * Sources are capped so provenance stays bounded; the full history lives
 * in the filechange rungs, this is a snapshot, not an archive. Returns
 * null when there's nothing safe to update (no existing anchor, or it
 * has nested children this pass can't preserve).
 */
async function buildUpdatedFileRung(model: ModelBackend, existing: Awaited<ReturnType<typeof readAnchor>>, commit: CommitRow, changeSummary: string): Promise<Rung | null> {
  if (!existing) return null;
  if (existing.children.length > 0) return null;
  const previousClean = existing.summary.replace(/ \(previously:.*\)$/s, "");
  const synthesized = await model.summarize(
    `You maintain a short, current description of what a file is and does. Below is its existing description and a note about what changed in the latest commit. Decide first whether the change is material -- does it actually alter the file's purpose, behavior, or exports? If not (formatting, whitespace, comments, a rename with no behavior change, reordering with no effect), output the existing description completely unchanged, with no mention of the latest commit at all -- not even a passing remark that something was reformatted. Only write a revised description, folding in what changed, when the change is actually material. Never append the new note onto the old description as an extra sentence.\n\nExisting description: ${previousClean}\n\nWhat changed in the latest commit: ${changeSummary}\n\nUpdated description:`,
  );
  return {
    path: existing.path,
    kind: existing.kind,
    summary: synthesized ?? `${changeSummary} (previously: ${previousClean})`,
    sources: [{ kind: "commit" as const, ref: commit.sha, title: commit.message, author: commit.author, at: commit.at }, ...existing.sources].slice(0, 5),
    touches: existing.touches,
    children: [],
  };
}

interface AddFileChangePayload {
  commit: CommitRow;
  change: FileChangeRow;
  large: boolean;
  fileCount: number;
}

interface SummarizeChangesetPayload {
  commit: CommitRow;
  large: boolean;
  fileCount: number;
}

export async function ladderReplayCommits(slug: string, options: ReplayOptions): Promise<void> {
  const repo = resolveRepo(slug);
  ensureCloned(repo);
  const model = await resolveModelBackend();
  console.error(`model backend: ${model.name}`);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  let repoLane = readLane(repo.stateDir, REPO_RUNG_PATH);
  if (!repoLane) {
    repoLane = proposeLane(repo.stateDir, { id: REPO_RUNG_PATH, repo: slug, name: slug, objective: `the ${slug} repository`, scope: ["**"], proposedBy: COORDINATOR, coordinators: [COORDINATOR] });
  }
  const repoOrigin: LaneRef = { repo: slug, lane: repoLane.id };

  // --- handlers that run on the repo Lane's own queue: the only place
  // git notes actually get written. -----------------------------------
  const repoHandlers = {
    merge_request: async (theAsk: AskEntry) => {
      const { ladder } = theAsk.payload as { ladder: Rung | Rung[] };
      await mergeLaneLadder(repo.repoDir, repo.stateDir, ladder);
    },
    rung_update_request: async (theAsk: AskEntry) => {
      const { path, commit, changeSummary } = theAsk.payload as { path: string; commit: CommitRow; changeSummary: string };
      const existing = await readAnchor(repo.repoDir, repo.stateDir, path);
      const updated = await buildUpdatedFileRung(model, existing, commit, changeSummary);
      if (updated) await writeLadder(repo.repoDir, repo.stateDir, updated);
    },
    ingest_repo: async () => {
      const commits = listCommitsChronological(repo.repoDir);
      const limit = options.limit ?? commits.length;
      const sessionLane = proposeLane(repo.stateDir, {
        id: shortId("replay"),
        repo: slug,
        name: `replay session (${new Date().toISOString()})`,
        objective: "walk the commit log and build a changeset per commit",
        scope: ["**"],
        origin: repoOrigin,
        proposedBy: AGENT,
        coordinators: [AGENT],
      });

      let posted = 0;
      let skipped = 0;
      for (const commit of commits) {
        if (posted >= limit) break;
        if (!options.force && (await isPresent(repo.repoDir, repo.stateDir, `changesets/${commit.sha}`))) {
          skipped += 1;
          continue;
        }
        ask(repo.stateDir, sessionLane.id, { kind: "analyze_changeset", from: AGENT, payload: { commit } });
        posted += 1;
      }
      console.error(`posted ${posted} analyze_changeset ask(s), ${skipped} commit(s) already onboarded`);

      await runWorkerLoop(repo.stateDir, sessionLane.id, AGENT, {
        analyze_changeset: async (theAsk) => {
          const { commit } = theAsk.payload as { commit: CommitRow };
          const changes = commitFileChanges(repo.repoDir, commit);
          const large = changes.length > maxFiles;
          console.error(`${commit.sha.slice(0, 7)} "${commit.message}" -- ${changes.length} file(s)${large ? " (large commit: mechanical only)" : ""}`);

          const changesetLane = proposeLane(repo.stateDir, {
            id: `commit-${commit.sha.slice(0, 10)}`,
            repo: slug,
            name: `analyze commit ${commit.sha.slice(0, 7)}`,
            objective: commit.message,
            scope: [`changesets/${commit.sha}`],
            origin: { repo: slug, lane: sessionLane.id },
            proposedBy: AGENT,
            coordinators: [AGENT],
          });

          const fileAskIds: string[] = [];
          for (const change of changes) {
            const payload: AddFileChangePayload = { commit, change, large, fileCount: changes.length };
            const fileAsk = ask(repo.stateDir, changesetLane.id, { kind: "add_filechange", from: AGENT, payload });
            fileAskIds.push(fileAsk.id);
          }
          const summarizePayload: SummarizeChangesetPayload = { commit, large, fileCount: changes.length };
          ask(repo.stateDir, changesetLane.id, { kind: "summarize_changeset", from: AGENT, payload: summarizePayload, depends_on: fileAskIds });

          await runWorkerLoop(repo.stateDir, changesetLane.id, AGENT, {
            add_filechange: async (fcAsk) => {
              const { commit: c, change, large: isLarge, fileCount } = fcAsk.payload as AddFileChangePayload;
              const rung = isLarge ? mechanicalFileChangeRung(c, change, fileCount) : await buildFileChangeRung(model, repo.repoDir, c, change);
              // Non-blocking: posted into the repo Lane's queue, not
              // awaited here. The repo Lane's own loop (resumed once
              // this whole ingest_repo handler returns) will get to it.
              if (!isLarge) {
                ask(repo.stateDir, repoLane!.id, { kind: "rung_update_request", from: AGENT, payload: { path: change.path, commit: c, changeSummary: rung.summary } });
              }
              return rung;
            },
            summarize_changeset: async (scAsk) => {
              const { commit: c, large: isLarge, fileCount } = scAsk.payload as SummarizeChangesetPayload;
              const lane = readLane(repo.stateDir, changesetLane.id)!;
              const fileChangeRungs = fileAskIds.map((id) => {
                const a = lane.history.find((e) => e.type === "ANSWER" && e.ask === id);
                return (a as { payload: Rung }).payload;
              });
              const changesetRung: Rung = {
                path: `changesets/${c.sha}`,
                kind: "changeset",
                summary: `${c.message} (${c.author}, ${c.at}). ${fileCount} file(s) changed.${isLarge ? " A large commit; files described at a glance, not individually." : ""}`,
                sources: [{ kind: "commit", ref: c.sha, title: c.message, author: c.author, at: c.at }],
                children: fileChangeRungs,
              };
              // Also non-blocking: fire the merge ask at the repo Lane's
              // queue and move on, same as the per-file rung updates.
              ask(repo.stateDir, repoLane!.id, { kind: "merge_request", from: AGENT, payload: { ladder: changesetRung } });
              return changesetRung;
            },
          });
        },
      });

      return { processed: posted, skipped, remaining: commits.length - posted - skipped };
    },
  };

  ask(repo.stateDir, repoLane.id, { kind: "ingest_repo", from: COORDINATOR });
  await runWorkerLoop(repo.stateDir, repoLane.id, COORDINATOR, repoHandlers);

  console.error("done.");
}
