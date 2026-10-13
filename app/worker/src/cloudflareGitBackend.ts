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
  const pending = new Map<string, PendingEntry>(files.map((f) => [f.path, { kind: "new" as const, content: f.content }]));
  const treeOid = await writeNestedTree(null, fs, dir, pending);
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

interface FlatEntry {
  oid: string;
  mode: string;
}

/** Walks a tree's "tree"-typed entries recursively, naming every real (blob/symlink/exec/gitlink) leaf by its full path relative to the root -- the native readTree binding only ever returns one level at a time, so this is the one place anything needs to actually recurse into subdirectories. */
async function flattenTree(repo: ArtifactsRepoHandle, treeHash: string, prefix: string, out: Map<string, FlatEntry>): Promise<void> {
  const entries = await repo.readTree(treeHash);
  if (!entries) return;
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === "tree") {
      await flattenTree(repo, entry.hash, path, out);
    } else {
      out.set(path, { oid: entry.hash, mode: entry.mode });
    }
  }
}

type PendingEntry = { kind: "existing"; oid: string; mode: string } | { kind: "new"; content: string };

/**
 * Writes a real, nested git tree from a flat `path -> entry` map,
 * grouping by each path's first segment and recursing for anything
 * with a "/" left in it -- the inverse of flattenTree, and the actual
 * fix for subdirectory support: a single flat tree object can't
 * represent "tests/test_shoes.py" at all, it needs a "tests" tree
 * entry pointing at its own child tree. Existing (unchanged) entries
 * are re-fetched and re-written by content so their oid reproduces
 * exactly (same reasoning commitChangesetOnArtifacts always used for
 * its flat unchanged entries); new ones are written straight from the
 * proposed content. Returns the oid of the tree written at this level.
 */
async function writeNestedTree(repo: ArtifactsRepoHandle | null, fs: ReturnType<typeof createMemFs>, dir: string, flat: Map<string, PendingEntry>): Promise<string> {
  const topLevel = new Map<string, { entry?: PendingEntry; children?: Map<string, PendingEntry> }>();
  for (const [path, entry] of flat) {
    const slash = path.indexOf("/");
    if (slash === -1) {
      topLevel.set(path, { entry });
      continue;
    }
    const name = path.slice(0, slash);
    const rest = path.slice(slash + 1);
    let node = topLevel.get(name);
    if (!node?.children) {
      node = { children: new Map() };
      topLevel.set(name, node);
    }
    node.children!.set(rest, entry);
  }

  const treeEntries: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
  for (const [name, node] of topLevel) {
    if (node.children) {
      const subOid = await writeNestedTree(repo, fs, dir, node.children);
      treeEntries.push({ mode: "40000", path: name, oid: subOid, type: "tree" });
      continue;
    }
    const entry = node.entry!;
    if (entry.kind === "existing") {
      if (!repo) throw new Error(`internal error: an "existing" tree entry ("${name}") with no repo to read it from -- should never happen outside commitChangesetOnArtifacts`);
      const blob = await repo.readBlob(entry.oid);
      if (!blob) throw new Error(`could not read unchanged blob for "${name}" (${entry.oid})`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const oid = await git.writeBlob({ fs, dir, blob: bytes });
      treeEntries.push({ mode: entry.mode, path: name, oid, type: "blob" });
    } else {
      const oid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(entry.content) });
      treeEntries.push({ mode: "100644", path: name, oid, type: "blob" });
    }
  }
  return git.writeTree({ fs, dir, tree: treeEntries });
}

/**
 * Commits a changeset against a real Artifacts repo without ever
 * cloning its history: reads the parent tree natively (recursively,
 * via flattenTree, so entries in subdirectories are found too),
 * reconstructs every entry locally (re-fetching unchanged files' real
 * bytes so their oid matches -- confirmed this reproduces the
 * identical oid, since git blob hashing is purely content-addressed),
 * overlays the proposed files, writes the real nested tree structure
 * (writeNestedTree), and pushes.
 */
export async function commitChangesetOnArtifacts(repoName: string, remote: string, token: { plaintext: string } | string, repo: ArtifactsRepoHandle, input: { files: ChangesetFile[]; message: string; author: CommitAuthor }): Promise<string> {
  const parentOid = await headOid(repo);
  const parentCommit = await repo.readCommit(parentOid);
  if (!parentCommit) throw new Error(`could not read parent commit ${parentOid}`);

  const flat = new Map<string, FlatEntry>();
  await flattenTree(repo, parentCommit.treeHash, "", flat);

  const pending = new Map<string, PendingEntry>();
  for (const [path, entry] of flat) pending.set(path, { kind: "existing", ...entry });
  for (const f of input.files) pending.set(f.path, { kind: "new", content: f.content });

  const fs = createMemFs();
  const dir = "/repo";
  await git.init({ fs, dir, defaultBranch: "main" });

  const treeOid = await writeNestedTree(repo, fs, dir, pending);
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
