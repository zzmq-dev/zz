// Git content (commitChangeset + reads) against a real Artifacts repo
// -- the other half of Backend the DO needs, alongside
// doLaneBackend.ts's Lane/Ask/Answer storage. Reads go straight
// through the native ARTIFACTS binding (readCommit/readTree/readBlob
// -- no isomorphic-git, no clone, verified directly in step 2).
// Writing a commit uses the "minimal object" push pattern proven live
// in step 2's scratch test: never clone the repo's history locally,
// just reconstruct the handful of objects a push actually needs --
// the parent tree's unchanged entries (re-fetched by content via the
// native binding, which reproduces the same oid) plus whatever's
// actually new -- into a throwaway in-memory fs, then push.
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createMemFs } from "./memFs.js";
import type { ChangesetFile, CommitAuthor } from "../../engine/changeset.js";

// Aliases, not reimplementations: @cloudflare/workers-types ambiently
// declares the real Artifacts/ArtifactsRepo/ArtifactsCommitMetadata
// shapes (confirmed directly against node_modules -- info() does
// exist and does carry `remote`; commit metadata does carry
// authoredAt/committedAt/committer). A hand-rolled copy of these
// interfaces lived here before and drifted from the real ones
// (missing info(), missing authoredAt) -- caught by tsc once
// cloudflareBackend.ts actually exercised those fields. Aliasing
// keeps these names stable for every file that imports them.
export type ArtifactsCommit = ArtifactsCommitMetadata;
export type ArtifactsRepoHandle = ArtifactsRepo;
export type ArtifactsNamespace = Artifacts;

function tokenString(token: { plaintext: string } | string): string {
  return typeof token === "string" ? token.split("?")[0] : token.plaintext;
}

/**
 * Pushes a brand-new repo's first commit. Needed because
 * commitChangesetOnArtifacts always diffs against a parent via
 * headOid() -- a repo with zero commits has nothing to diff against,
 * so every real repo needs exactly one of these before
 * commit_changeset (or any Ladder/zz-meta write, which all anchor to
 * a commit) can touch it. Safe to call with an empty `files` array
 * (an empty-tree root commit).
 */
export async function createInitialCommit(remote: string, token: { plaintext: string } | string, files: { path: string; content: string }[], author: CommitAuthor): Promise<string> {
  const fs = createMemFs();
  const dir = "/init";
  await git.init({ fs, dir, defaultBranch: "main" });
  const entries: { mode: string; path: string; oid: string; type: "blob" }[] = [];
  for (const f of files) {
    const oid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(f.content) });
    entries.push({ mode: "100644", path: f.path, oid, type: "blob" });
  }
  const treeOid = await git.writeTree({ fs, dir, tree: entries });
  const person = { name: author.name, email: author.email, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  const commitOid = await git.writeCommit({ fs, dir, commit: { message: "initial commit", tree: treeOid, parent: [], author: person, committer: person } });
  await git.writeRef({ fs, dir, ref: "refs/heads/main", value: commitOid, force: true });
  const onAuth = () => ({ username: "x-token-auth", password: tokenString(token) });
  const pushResult = await git.push({ fs, http, dir, url: remote, onAuth, ref: "main", remoteRef: "main" });
  if (!pushResult.ok) throw new Error(`initial commit push rejected: ${JSON.stringify(pushResult.refs)}`);
  return commitOid;
}

/** The repo's current HEAD commit, via the native binding -- no clone. */
export async function headOid(repo: ArtifactsRepoHandle): Promise<string> {
  const [latest] = await repo.log({ ref: "main", limit: 1 });
  if (!latest) throw new Error("repo has no commits yet");
  return latest.hash;
}

/**
 * Commits a changeset against a real Artifacts repo without ever
 * cloning its history: reads the parent tree natively, reconstructs
 * every entry locally (re-fetching unchanged files' real bytes so
 * their oid matches -- confirmed this reproduces the identical oid,
 * since git blob hashing is purely content-addressed), overlays the
 * proposed files, and pushes. Flat paths only, matching
 * engine/changeset.ts's own real commitChangeset.
 */
export async function commitChangesetOnArtifacts(repoName: string, remote: string, token: { plaintext: string } | string, repo: ArtifactsRepoHandle, input: { files: ChangesetFile[]; message: string; author: CommitAuthor }): Promise<string> {
  for (const f of input.files) {
    if (f.path.includes("/")) throw new Error(`commitChangesetOnArtifacts: "${f.path}" has a subdirectory; only flat, single-segment paths are supported right now.`);
  }

  const parentOid = await headOid(repo);
  const parentCommit = await repo.readCommit(parentOid);
  if (!parentCommit) throw new Error(`could not read parent commit ${parentOid}`);
  const parentTree = (await repo.readTree(parentCommit.treeHash)) ?? [];

  const fs = createMemFs();
  const dir = "/repo";
  await git.init({ fs, dir, defaultBranch: "main" });

  const changedPaths = new Set(input.files.map((f) => f.path));
  const entries: { mode: string; path: string; oid: string; type: "blob" }[] = [];

  // Unchanged entries: re-fetch their real bytes natively and rewrite
  // the identical blob locally, so the new tree can reference them
  // without ever having cloned them.
  for (const entry of parentTree) {
    if (changedPaths.has(entry.name)) continue;
    const blob = await repo.readBlob(entry.hash);
    if (!blob) throw new Error(`could not read unchanged blob for "${entry.name}" (${entry.hash})`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const oid = await git.writeBlob({ fs, dir, blob: bytes });
    entries.push({ mode: entry.mode, path: entry.name, oid, type: "blob" });
  }
  // New/changed entries: write directly from the proposed content.
  for (const f of input.files) {
    const oid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(f.content) });
    entries.push({ mode: "100644", path: f.path, oid, type: "blob" });
  }

  const treeOid = await git.writeTree({ fs, dir, tree: entries });
  const person = { name: input.author.name, email: input.author.email, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  const commitOid = await git.writeCommit({ fs, dir, commit: { message: input.message, tree: treeOid, parent: [parentOid], author: person, committer: person } });
  await git.writeRef({ fs, dir, ref: "refs/heads/main", value: commitOid, force: true });

  const onAuth = () => ({ username: "x-token-auth", password: tokenString(token) });
  const pushResult = await git.push({ fs, http, dir, url: remote, onAuth, ref: "main", remoteRef: "main" });
  if (!pushResult.ok) throw new Error(`push rejected: ${JSON.stringify(pushResult.refs)}`);

  return commitOid;
}

export async function readFileAtCommit(repo: ArtifactsRepoHandle, commitHash: string, path: string): Promise<string> {
  const commit = await repo.readCommit(commitHash);
  if (!commit) return "";
  const tree = await repo.readTree(commit.treeHash);
  const entry = tree?.find((e) => e.name === path);
  if (!entry) return "";
  const blob = await repo.readBlob(entry.hash);
  return blob ? await blob.text() : "";
}
