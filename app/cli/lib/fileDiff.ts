// A real unified diff (not a side-by-side full-file redump) between two
// in-memory file sets -- what `zz work --assist`'s chat transcript shows
// for a revision, so a human reviewing a second/third draft sees what
// actually changed instead of re-reading the whole file from scratch
// every turn. Shells out to `git diff --no-index` against two temp
// files rather than hand-rolling a diff algorithm: it's already
// installed everywhere this runs, and `--color=always` gives a real
// ANSI-colored unified diff for free.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FileEntry {
  path: string;
  content: string;
}

/** One block of diff text per changed/added file (joined with blank lines); omits files whose content is identical in both sets. Empty string if nothing changed. */
export function diffFileSets(before: FileEntry[], after: FileEntry[]): string {
  const beforeMap = new Map(before.map((f) => [f.path, f.content]));
  const blocks: string[] = [];
  for (const f of after) {
    const prev = beforeMap.get(f.path);
    if (prev === f.content) continue;
    if (prev === undefined) {
      blocks.push(`--- ${f.path} (new) ---\n${f.content}`);
      continue;
    }
    blocks.push(`--- ${f.path} ---\n${unifiedDiff(prev, f.content, f.path)}`);
  }
  return blocks.join("\n\n");
}

// Drops git's own "diff --git <tempdir>/a <tempdir>/b" / "index .." /
// "--- a" / "+++ b" header lines -- the caller already prints a clean
// "--- <real path> ---" label above this, and the temp paths those
// headers carry are meaningless noise in a chat transcript. Keeps
// everything from the first "@@" hunk marker onward.
function stripHeader(diffText: string): string {
  const lines = diffText.split("\n");
  const hunkStart = lines.findIndex((l) => l.replace(/\x1b\[[0-9;]*m/g, "").startsWith("@@"));
  return (hunkStart === -1 ? lines : lines.slice(hunkStart)).join("\n");
}

function unifiedDiff(before: string, after: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), "zz-diff-"));
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    writeFileSync(a, before);
    writeFileSync(b, after);
    try {
      // git diff --no-index exits 0 only when the files are identical
      // (never reached here -- the caller already checked that) --
      // exit 1 means "real diff produced," which execFileSync treats
      // as a thrown error whose own .stdout still has the diff text.
      return stripHeader(execFileSync("git", ["diff", "--no-index", "--color=always", a, b], { encoding: "utf8" }));
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout;
      return stdout ? stripHeader(stdout) : `(couldn't compute a diff for ${label} -- showing it unchanged)`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
