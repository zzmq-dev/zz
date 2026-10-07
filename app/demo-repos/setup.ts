// Clones the real repos used for the superagent/supertest demo slice.
// Idempotent: skips any repo that's already cloned.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Both repos transferred orgs since this was first written: ladjs/superagent
// and visionmedia/supertest are now GitHub redirects, the real canonical
// names are under forwardemail (verified via `gh api repos/<old>` --jq
// '.full_name', which GitHub resolves to the current name even for a
// renamed repo). Clone from the canonical URL, not the redirect, since a
// redirect isn't guaranteed to hold forever if the old name is ever reused.
const repos = [
  { name: "superagent", url: "https://github.com/forwardemail/superagent.git" },
  { name: "supertest", url: "https://github.com/forwardemail/supertest.git" },
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
