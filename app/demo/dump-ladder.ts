// Materializes a repo's Ladder (stored as git notes, not easy to browse
// directly) into one flat, readable text file. A dump for a human to look
// at, not a second source of truth; re-run any time after the real notes
// change, since this always reads live from the repo's own notes refs.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLadder } from "../engine/ladderRender.js";

const repoName = process.argv[2];
if (!repoName) {
  console.error("usage: tsx demo/dump-ladder.ts <repo-name>   (e.g. supertest)");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, "..", "demo-repos", repoName);
const stateDir = join(here, "..", "state", repoName);
const outPath = join(stateDir, "ladder.txt");

const { text, stats } = await renderLadder(repoDir, stateDir);
const header = `# Ladder dump for ${repoName}\n# ${stats.rungs} rungs, from ${stats.notes} git notes. Generated ${new Date().toISOString()}.\n# This is a materialized view for reading; the real data lives in refs/notes/zz/ladder/* inside ${repoDir}.\n\n`;

writeFileSync(outPath, header + text + "\n");
console.log(`wrote ${outPath} (${stats.rungs} rungs, ${stats.notes} notes)`);
