// Composing and committing a real code change directly from protocol
// data -- no working-tree file, no `write_file` tool. The content of
// every changed file lives entirely in the Ask/Answer payload that
// proposed it (the same way a Rung carries its own full content); this
// is the one place that content actually becomes a real git commit,
// using isomorphic-git's plumbing (writeBlob/writeTree/writeCommit/
// writeRef) rather than a working-tree checkout. That also makes this
// directly portable to the Cloudflare move: a Worker has no persistent
// working tree either, so building a commit from in-memory content is
// the only shape that was ever going to survive that move.
//
// Flat paths only (single path segment, no subdirectories) -- writeTree
// writes one tree level per call, so a nested path would need manual
// subtree construction. Not needed yet; add it if a real changeset
// actually requires nested directories.
import * as git from "isomorphic-git";
import fs from "node:fs";

export interface ChangesetFile {
  path: string;
  content: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export async function commitChangeset(repoDir: string, input: { files: ChangesetFile[]; message: string; author: CommitAuthor }): Promise<string> {
  for (const f of input.files) {
    if (f.path.includes("/")) throw new Error(`commitChangeset: "${f.path}" has a subdirectory; only flat, single-segment paths are supported right now.`);
  }

  let parentOid: string | undefined;
  try {
    parentOid = await git.resolveRef({ fs, dir: repoDir, ref: "HEAD" });
  } catch {
    parentOid = undefined; // the repo's first commit
  }

  const entries: git.TreeEntry[] = parentOid ? (await git.readTree({ fs, dir: repoDir, oid: parentOid })).tree : [];

  for (const f of input.files) {
    const oid = await git.writeBlob({ fs, dir: repoDir, blob: new TextEncoder().encode(f.content) });
    const entry: git.TreeEntry = { mode: "100644", path: f.path, oid, type: "blob" };
    const i = entries.findIndex((e) => e.path === f.path);
    if (i >= 0) entries[i] = entry;
    else entries.push(entry);
  }

  const treeOid = await git.writeTree({ fs, dir: repoDir, tree: entries });
  const timestamp = Math.floor(Date.now() / 1000);
  const person = { ...input.author, timestamp, timezoneOffset: 0 };
  const commitOid = await git.writeCommit({
    fs,
    dir: repoDir,
    commit: { message: input.message, tree: treeOid, parent: parentOid ? [parentOid] : [], author: person, committer: person },
  });

  const branch = (await git.currentBranch({ fs, dir: repoDir })) ?? "main";
  await git.writeRef({ fs, dir: repoDir, ref: `refs/heads/${branch}`, value: commitOid, force: true });

  return commitOid;
}
