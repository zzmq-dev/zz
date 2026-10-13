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
  kind: "repo" | "file" | "changeset" | "filechange";
  summary: string;
  sources: { kind: "commit"; ref: string; title: string; author: string; at: string }[];
  children: SimpleRung[];
}

export interface EmbeddedRef {
  ref: string;
}

export interface EmbeddedRung {
  path: string;
  kind: string;
  summary: string;
  sources: unknown[];
  children: (EmbeddedRung | EmbeddedRef)[];
}

function isRef(x: EmbeddedRung | EmbeddedRef): x is EmbeddedRef {
  return "ref" in x;
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

// The repo's first commit (no parents) -- a fixed point that never
// changes for the life of the repo, the anchor "repo"-kind rungs use
// (matching engine/ladderNotes.ts's anchorSha, which has the same
// reason: HEAD's tree sha changes on every commit, which would
// silently orphan _repo's note on the very next one). repo.log's
// `limit` caps at 1000 per Cloudflare's docs; fine for a demo-scale
// repo, a real limitation for anything with deeper history -- walking
// further back would need repo.log's pagination, not added here since
// nothing in the live agent loop has needed it yet.
export async function rootCommitOid(repo: ArtifactsRepoHandle): Promise<string> {
  const history = await repo.log({ ref: "main", limit: 1000 });
  const root = history[history.length - 1];
  if (!root) throw new Error("repo has no commits yet");
  return root.hash;
}

async function anchorShaForRung(repo: ArtifactsRepoHandle, rung: Pick<SimpleRung, "kind" | "path" | "sources">): Promise<string> {
  if (rung.kind === "repo") return rootCommitOid(repo);
  if (rung.kind === "changeset") {
    const source = rung.sources.find((s) => s.kind === "commit");
    if (!source) throw new Error(`${rung.path}: no commit source to anchor a note to`);
    return source.ref;
  }
  return anchorShaForFile(repo, rung.path);
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

async function pushNote(remote: string, token: { plaintext: string } | string, fs: ReturnType<typeof createMemFs>, dir: string, ref: string, anchorSha: string, content: unknown): Promise<void> {
  const person = { name: "zz-ladder", email: "zz-ladder@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  await git.addNote({ fs, dir, ref, oid: anchorSha, note: JSON.stringify(content), force: true, author: person, committer: person });
  const onAuth = () => ({ username: "x-token-auth", password: tokenString(token) });
  const pushResult = await git.push({ fs, http, dir, url: remote, onAuth, ref, remoteRef: ref });
  if (!pushResult.ok) throw new Error(`push of ${ref} rejected: ${JSON.stringify(pushResult.refs)}`);
}

export async function writeRung(remote: string, token: { plaintext: string } | string, repo: ArtifactsRepoHandle, rung: SimpleRung): Promise<void> {
  const ref = notesRefFor(rung.kind);
  const anchorSha = await anchorShaForRung(repo, rung);
  const { fs, dir } = await scopedNotesCheckout(remote, token, ref);
  await pushNote(remote, token, fs, dir, ref, anchorSha, embed(rung));
}

// One repo-wide Ladder read (the "_repo" root plus each of its
// top-level file/changeset children, resolved one DO call at a time
// by webApp.ts's getLadderTree) used to re-run scopedNotesCheckout
// from scratch for every single one of those calls -- even though
// every "file"/"directory"/"function"/"lines" rung shares the exact
// same notes ref ("code"), so three file children meant fetching that
// identical ref three separate times. Confirmed live: this, not any
// one slow call, was the real cost of the Ladder tab (~2.8s of a
// ~3.4s fetch, for a repo with only 5 top-level children). A cache
// keyed by ref name, shared across every readRung call that passes
// the SAME NotesCache object, fixes that -- callers that want this
// sharing pass one cache instance across a batch of reads (see
// cloudflareBackend.ts's readAnchorFor); nothing requires it.
export type NotesCache = Map<string, { fs: ReturnType<typeof createMemFs>; dir: string; hadExisting: boolean }>;

export async function readRung(remote: string, token: { plaintext: string } | string, repo: ArtifactsRepoHandle, kind: SimpleRung["kind"], path: string, explicitAnchorSha?: string, cache?: NotesCache): Promise<EmbeddedRung | null> {
  const ref = notesRefFor(kind);
  const anchorSha = explicitAnchorSha ?? (await anchorShaForRung(repo, { kind, path, sources: [] }));
  let checkout = cache?.get(ref);
  if (!checkout) {
    checkout = await scopedNotesCheckout(remote, token, ref);
    cache?.set(ref, checkout);
  }
  const { fs, dir, hadExisting } = checkout;
  if (!hadExisting) return null;
  try {
    const raw = await git.readNote({ fs, dir, ref, oid: anchorSha });
    return JSON.parse(new TextDecoder().decode(raw)) as EmbeddedRung;
  } catch {
    return null;
  }
}

/**
 * Adds references to the repo root's own note without touching any
 * existing child, written or not -- the Cloudflare twin of
 * engine/ladderNotes.ts's appendRepoChildren, same reason: writeRung
 * always overwrites a rung's whole note, which is right when writing
 * that rung itself but would re-derive and clobber the _repo root's
 * already-correct children list if every other write went through it
 * too. mergeLaneLadder calls this after every non-root rung write, so
 * this has to work for the Cloudflare path to be functionally
 * complete, not just for "repo"-kind writes specifically.
 */
export async function appendRepoChildren(remote: string, token: { plaintext: string } | string, repo: ArtifactsRepoHandle, newChildren: { path: string; kind: string }[]): Promise<void> {
  const ref = notesRefFor("repo");
  const anchorSha = await rootCommitOid(repo);
  const { fs, dir, hadExisting } = await scopedNotesCheckout(remote, token, ref);
  if (!hadExisting) throw new Error("repo root has no note yet; write the root rung first");
  const current = JSON.parse(new TextDecoder().decode(await git.readNote({ fs, dir, ref, oid: anchorSha }))) as EmbeddedRung;
  const existingRefs = new Set(current.children.filter(isRef).map((c) => c.ref));
  const toAdd = newChildren.filter((c) => !existingRefs.has(c.path));
  if (toAdd.length === 0) return;
  current.children.push(...toAdd.map((c) => ({ ref: c.path })));
  await pushNote(remote, token, fs, dir, ref, anchorSha, current);
}
