// The Ladder (git notes) against a real Artifacts repo -- the piece
// flagged as harder than the changeset-commit path, now proven: the
// native ARTIFACTS binding's read methods (log/readCommit/readTree)
// only resolve the default branch, confirmed directly (a notes ref
// returns an empty log no matter how it's spelled) -- notes need
// isomorphic-git for both reads and writes. Unlike the main branch,
// though, a notes ref's own history is small (one commit per past
// Ladder write, not the project's full development history), so a
// real, scoped `git.fetch` of just that one ref is cheap regardless
// of how large or old the repo gets -- no reason to hold it to the
// same no-clone constraint the changeset-commit path needed.
//
// Scoped to what agent/scriptedWork.ts actually writes: "file" rungs
// (anchored to a path's blob at HEAD) and "changeset" rungs (anchored
// to the commit itself, with "filechange" children embedded inline,
// never as separate notes -- matching engine/ladderNotes.ts's own
// anchor rules). Directories, releases, ask-threads, dependencies are
// real rung kinds engine/ladderNotes.ts handles locally but nothing
// in the live agent loop writes yet; add them here the same way if
// that changes.
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createMemFs } from "./memFs.js";
import type { ArtifactsRepoHandle } from "./cloudflareGitBackend.js";

export interface SimpleRung {
  path: string;
  kind: "file" | "changeset" | "filechange";
  summary: string;
  sources: { kind: "commit"; ref: string; title: string; author: string; at: string }[];
  children: SimpleRung[];
}

export interface EmbeddedRung {
  path: string;
  kind: string;
  summary: string;
  sources: unknown[];
  children: EmbeddedRung[];
}

function notesRefFor(kind: SimpleRung["kind"]): string {
  if (kind === "changeset") return "refs/notes/zz/ladder/changeset";
  return "refs/notes/zz/ladder/code";
}

function embed(rung: SimpleRung): EmbeddedRung {
  return { path: rung.path, kind: rung.kind, summary: rung.summary, sources: rung.sources, children: rung.children.map(embed) };
}

function tokenString(token: { plaintext: string } | string): string {
  return typeof token === "string" ? token.split("?")[0] : token.plaintext;
}

async function anchorShaForFile(repo: ArtifactsRepoHandle, path: string): Promise<string> {
  const [headCommit] = await repo.log({ ref: "main", limit: 1 });
  if (!headCommit) throw new Error("repo has no commits yet");
  const tree = await repo.readTree(headCommit.treeHash);
  const entry = tree?.find((e) => e.name === path);
  if (!entry) throw new Error(`"${path}" not found in the repo at HEAD`);
  return entry.hash;
}

/** A fresh, throwaway isomorphic-git dir with just one notes ref fetched into it (or empty, if that ref doesn't exist on the remote yet) -- never the main branch, never the rest of history. */
async function scopedNotesCheckout(remote: string, token: { plaintext: string } | string, ref: string): Promise<{ fs: ReturnType<typeof createMemFs>; dir: string; hadExisting: boolean }> {
  const fs = createMemFs();
  const dir = "/notes";
  await git.init({ fs, dir, defaultBranch: "main" });
  await git.addRemote({ fs, dir, remote: "origin", url: remote });
  const onAuth = () => ({ username: "x-token-auth", password: tokenString(token) });
  try {
    const result = await git.fetch({ fs, http, dir, remote: "origin", onAuth, ref, remoteRef: ref, singleBranch: true, tags: false });
    if (result.fetchHead) {
      await git.writeRef({ fs, dir, ref, value: result.fetchHead, force: true });
      return { fs, dir, hadExisting: true };
    }
    return { fs, dir, hadExisting: false };
  } catch {
    // The ref genuinely doesn't exist yet on the remote (first write ever) -- start from nothing, same as a fresh repo's first note.
    return { fs, dir, hadExisting: false };
  }
}

export async function writeRung(remote: string, token: { plaintext: string } | string, repo: ArtifactsRepoHandle, rung: SimpleRung): Promise<void> {
  const ref = notesRefFor(rung.kind);
  const anchorSha = rung.kind === "changeset" ? rung.sources.find((s) => s.kind === "commit")!.ref : await anchorShaForFile(repo, rung.path);
  const { fs, dir } = await scopedNotesCheckout(remote, token, ref);
  const person = { name: "zz-ladder", email: "zz-ladder@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  await git.addNote({ fs, dir, ref, oid: anchorSha, note: JSON.stringify(embed(rung)), force: true, author: person, committer: person });
  const onAuth = () => ({ username: "x-token-auth", password: tokenString(token) });
  const pushResult = await git.push({ fs, http, dir, url: remote, onAuth, ref, remoteRef: ref });
  if (!pushResult.ok) throw new Error(`push of ${ref} rejected: ${JSON.stringify(pushResult.refs)}`);
}

export async function readRung(remote: string, token: { plaintext: string } | string, repo: ArtifactsRepoHandle, kind: SimpleRung["kind"], path: string, explicitAnchorSha?: string): Promise<EmbeddedRung | null> {
  const ref = notesRefFor(kind);
  const anchorSha = explicitAnchorSha ?? (await anchorShaForFile(repo, path));
  const { fs, dir, hadExisting } = await scopedNotesCheckout(remote, token, ref);
  if (!hadExisting) return null;
  try {
    const raw = await git.readNote({ fs, dir, ref, oid: anchorSha });
    return JSON.parse(new TextDecoder().decode(raw)) as EmbeddedRung;
  } catch {
    return null;
  }
}
