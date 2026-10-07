// Low-level git notes I/O, via isomorphic-git rather than shelling out to
// the real git binary. Notes live inside the repo they annotate (the real
// clone under demo-repos/), under their own ref namespace, so they never
// touch the tracked working tree. Regenerable from the Ladder build
// script, not a source of truth in their own right.
//
// Chose isomorphic-git over shelling out to `git`, and over a native
// binding like es-git, for one reason that isn't speed: it's pure JS, so
// it's the only one of the three that can run in Cloudflare Workers, the
// actual target deployment. Workers has no child_process and no native
// addon loading, so both `execFileSync("git", ...)` and an N-API module
// like es-git simply don't run there, no matter how fast they are
// locally. es-git (libgit2 via napi-rs) is a better fit for local-only
// tooling later (the TUI), where it isn't Workers-constrained.
import * as git from "isomorphic-git";
import fs from "node:fs";

const AUTHOR = { name: "zz-onboarding", email: "zz-onboarding@local" };

async function headCommitOid(dir: string): Promise<string> {
  return git.resolveRef({ fs, dir, ref: "HEAD" });
}

/** Resolves a path at HEAD to its blob (file) or tree (directory) SHA. Null if the path doesn't exist. */
export async function resolvePathSha(repoDir: string, path: string): Promise<string | null> {
  const oid = await headCommitOid(repoDir);
  try {
    const { oid: blobOid } = await git.readBlob({ fs, dir: repoDir, oid, filepath: path });
    return blobOid;
  } catch {
    try {
      const { oid: treeOid } = await git.readTree({ fs, dir: repoDir, oid, filepath: path });
      return treeOid;
    } catch {
      return null;
    }
  }
}

export async function resolveRootTreeSha(repoDir: string): Promise<string> {
  const oid = await headCommitOid(repoDir);
  const { oid: treeOid } = await git.readTree({ fs, dir: repoDir, oid });
  return treeOid;
}

/** Expands a short (abbreviated) SHA to the full 40-character one. Git notes key by full SHA internally, so a note written under a short SHA is invisible to the real `git notes` CLI even though isomorphic-git itself round-trips it. */
export async function expandOid(repoDir: string, shortOid: string): Promise<string> {
  return git.expandOid({ fs, dir: repoDir, oid: shortOid });
}

export async function writeNote(repoDir: string, ref: string, sha: string, content: unknown): Promise<void> {
  await git.addNote({ fs, dir: repoDir, ref, oid: sha, note: JSON.stringify(content), force: true, author: AUTHOR, committer: AUTHOR });
}

export async function readNote<T>(repoDir: string, ref: string, sha: string): Promise<T | null> {
  try {
    const raw = await git.readNote({ fs, dir: repoDir, ref, oid: sha });
    return JSON.parse(Buffer.from(raw).toString("utf8")) as T;
  } catch {
    return null;
  }
}
