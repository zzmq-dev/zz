// A real line-level 3-way merge (git's own `merge-file`, the same
// machinery `git merge`/`git rebase` use), not symbol-name comparison.
// Replaces asking a model to regenerate whole files from two divergent
// blobs -- unreliable even in the trivial additive case (observed
// directly: gpt-oss-120b dropped the same export identically on every
// retry when asked to "reconcile" two full versions). Most conflicts
// aren't real conflicts at all once you look at lines instead of
// names: two proposals touching different files, or different lines
// of the same file, merge cleanly with zero model involvement. Only a
// genuine overlapping-line conflict needs any judgment at all, and
// even then the model only ever sees the few marked lines that
// actually conflict, not the whole file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileContentAtCommit } from "../engine/ingest.js";

export interface MergeResult {
  clean: boolean;
  /** Final content for every proposal file that merged cleanly (including ones no other change touched at all). */
  files: { path: string; content: string }[];
  /** Files with a real line-level overlap -- content includes git's own <<<<<<</=======/>>>>>>> (and |||||||  base, via --diff3) markers. */
  conflicts: { path: string; markedContent: string }[];
}

function changedPaths(repoDir: string, fromSha: string, toSha: string): Set<string> {
  if (fromSha === toSha) return new Set();
  const out = execFileSync("git", ["-C", repoDir, "diff", "--name-only", fromSha, toSha], { encoding: "utf8" });
  return new Set(out.split("\n").filter(Boolean));
}

export function threeWayMerge(repoDir: string, baseSha: string, proposalFiles: { path: string; content: string }[]): MergeResult {
  const headSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (baseSha === headSha) {
    // Nothing landed since this proposal was generated -- no merge to do.
    return { clean: true, files: proposalFiles, conflicts: [] };
  }
  const changedByOthers = changedPaths(repoDir, baseSha, headSha);
  const files: { path: string; content: string }[] = [];
  const conflicts: { path: string; markedContent: string }[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "zz-merge-"));
  try {
    for (const f of proposalFiles) {
      if (!changedByOthers.has(f.path)) {
        // Nobody else touched this path -- the proposal's version applies cleanly on top of the current tree.
        files.push(f);
        continue;
      }
      const basePath = join(tmp, "base");
      const oursPath = join(tmp, "ours");
      const theirsPath = join(tmp, "theirs");
      writeFileSync(basePath, fileContentAtCommit(repoDir, baseSha, f.path));
      writeFileSync(oursPath, fileContentAtCommit(repoDir, headSha, f.path));
      writeFileSync(theirsPath, f.content);
      try {
        // -p: write the merge result to stdout instead of mutating
        // `ours` in place. --diff3 adds the base content into the
        // conflict markers too, so a model (or a human) resolving one
        // can see what changed on each side, not just the two results.
        const merged = execFileSync("git", ["merge-file", "-p", "--diff3", oursPath, basePath, theirsPath], { encoding: "utf8" });
        files.push({ path: f.path, content: merged });
      } catch (err) {
        // git merge-file's exit code is the NUMBER of conflicting
        // hunks it found, not a fixed 0/1 -- confirmed directly (two
        // separate conflicting regions in one file exits 2, not 1).
        // Only a negative status is a real error (git itself failing
        // to run, not a merge outcome); anything positive with real
        // stdout is conflict markers to hand back, however many hunks.
        const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
        if (typeof e.status === "number" && e.status > 0 && typeof e.stdout === "string") {
          conflicts.push({ path: f.path, markedContent: e.stdout });
        } else {
          throw new Error(`git merge-file failed on "${f.path}" (status ${e.status}): ${e.stderr || e.message || String(err)}`);
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { clean: conflicts.length === 0, files, conflicts };
}
