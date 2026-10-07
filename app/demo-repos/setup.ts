// Clones the real repos used for the superagent/supertest demo slice.
// Idempotent: skips any repo that's already cloned.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const repos = [
  { name: "superagent", url: "https://github.com/ladjs/superagent.git" },
  { name: "supertest", url: "https://github.com/visionmedia/supertest.git" },
];

for (const repo of repos) {
  const dest = join(here, repo.name);
  if (existsSync(dest)) {
    console.log(`already cloned: ${repo.name}`);
    continue;
  }
  console.log(`cloning ${repo.name}...`);
  execFileSync("git", ["clone", "--quiet", repo.url, dest], { stdio: "inherit" });
}

console.log("done.");
