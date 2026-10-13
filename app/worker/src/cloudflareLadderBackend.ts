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
// Originally scoped to just what agent/scriptedWork.ts's own live
// agent loop writes -- "file" rungs (anchored to a path's blob at
// HEAD) and "changeset" rungs (anchored to the commit itself, with
// "filechange" children embedded inline, never as separate notes --
// matching engine/ladderNotes.ts's own anchor rules). Now also covers
// what cli/commands/ladder-build.ts's remote-targeting onboarding
// needs: "directory"/"ask"/"contributor"/"dependencies" (none of
// these are a real path in the tree, so -- same reasoning as "repo" --
// they anchor to the repo's own fixed root commit, not a blob) and
// "release" (anchored to the real commit its tag points to, supplied
// via `sources` the same way "changeset" already is).
//
// Unlike engine/ladderNotes.ts's local equivalent, which gives each
// ask/contributor/dependency its own per-item notes ref,
// "directory"/"ask"/"contributor"/"dependencies" all share the one
// "code" ref here, same as "file"/"repo" -- a real round trip per
// distinct ref is the documented cost on this path (see NotesCache's
// own comment below), and a large onboarding run creating one new ref
// per issue/contributor would multiply that cost for no real benefit
// remotely. "release" gets its own ref, matching local.
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createMemFs } from "./memFs.js";
import type { ArtifactsRepoHandle } from "./cloudflareGitBackend.js";

export interface SimpleRung {
  path: string;
  kind: "repo" | "file" | "changeset" | "filechange" | "directory" | "release" | "ask" | "contributor" | "dependencies";
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
  if (kind === "release") return "refs/notes/zz/ladder/release";
  return "refs/notes/zz/ladder/code";
}

// None of these correspond to one real file blob -- same reasoning
// "repo" already anchors to the fixed root commit for (a directory
// listing/an issue thread/a contributor/a dependency all change
// independently of any one commit, so anchoring to HEAD's own tree
// would silently orphan the note on the very next unrelated commit).
// "release" is anchored here too, by the same path-derivability
// constraint changeset's own anchor sidesteps by embedding the sha
// directly in its path ("changesets/<sha>") -- a release's path
// ("releases/<tag>") doesn't carry a commit sha the read side could
// recover without a real tag lookup, which the remote repo may not
// even have pushed tags to resolve. The real commit a release maps to
// is still recorded in its own `sources`, just not used as the note's
// anchor.
const ROOT_ANCHORED_KINDS = new Set<SimpleRung["kind"]>(["repo", "directory", "ask", "contributor", "dependencies", "release"]);

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
  if (ROOT_ANCHORED_KINDS.has(rung.kind)) return rootCommitOid(repo);
  if (rung.kind === "changeset" || rung.kind === "release") {
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
  // pushResult.ok is an aggregate flag; per-ref status also confirmed ok
  // live for this exact failure, so this check isn't the fix -- see the
  // KNOWN ISSUE note on readRung below for what's actually going on.
  const refStatus = pushResult.refs?.[ref];
  if (!refStatus?.ok) throw new Error(`push of ${ref} rejected: ${refStatus?.error ?? JSON.stringify(pushResult)}`);
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

// KNOWN ISSUE, not yet fixed: a brand-new repo's writes to this ref
// (confirmed for "repo"/"file" kinds, which share one ref -- see
// notesRefFor) report success -- isomorphic-git's push() reports
// ok:true at both the aggregate AND per-ref level, and a same-request
// re-fetch (the next sequential rung in the same writeLadder batch)
// correctly sees the prior note via a brand-new scopedNotesCheckout --
// but a LATER, separate request's fetch of that exact ref fails with
// isomorphic-git's own NotFoundError ("Could not find <ref>"), so
// readRung below returns null forever after. Confirmed NOT a timing
// issue (retried after 45s and 120s, same result) and NOT caused by
// `singleBranch: true` on the fetch (tested without it, same result).
// Looks like an Artifacts-side consistency gap specific to non-branch
// refs (git notes) that's visible within the request that just wrote
// but not from a fresh connection -- not something fixable from this
// side without a different write/verify strategy (e.g. reading back
// after push and retrying, or writing notes as part of the same
// commit instead of a separate ref). Flagging for follow-up rather
// than chasing further right now.
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
