// Bulk onboarding pass for supertest: the real scale the hand-built
// ladder-full-supertest.ts deliberately didn't attempt (619 issues, 290
// PRs, 47 releases, 92 contributors). Lightweight by design: one real
// title/author/date per item, no deep comment-thread research the way
// asks/798 and asks/651 got. Run ladder-full-supertest.ts first; this
// extends what it wrote rather than replacing it, and skips the two
// issues and the one release already covered there in depth.
//
// All the actual fetching (gh api calls, tag->commit resolution) lives in
// engine/ingest.ts as real, reusable functions now, not inlined here;
// this file is just the supertest-specific knowledge on top of it (which
// two items to skip, what we already know about five specific
// contributors, the three real dependencies and the one real aggregate
// dependents count already verified for this repo). `zz ladder build`
// calls the same engine/ingest.ts functions generically for any repo.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rung, RungKind } from "../engine/ladder.js";
import { appendRepoChildren, writeLadder } from "../engine/ladderNotes.js";
import { fetchContributors, fetchIssues, fetchPullRequests, fetchReleases, resolveTagCommit, type ContributorRow, type IssueRow, type PrRow, type ReleaseRow } from "../engine/ingest.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, "..", "demo-repos", "supertest");
const stateDir = join(here, "..", "state", "supertest");
const REPO = "forwardemail/supertest";

const SKIP_ISSUES = new Set([651, 798]); // already covered in depth
const SKIP_RELEASES = new Set(["v6.3.1"]); // already covered in depth

function askFromIssue(i: IssueRow): Rung {
  const outcome = i.state === "closed" ? "closed" : "open";
  return {
    path: `asks/${i.number}`,
    kind: "ask",
    summary: `${i.user} ASKs: "${i.title}" (${outcome}, ${i.comments} real comments). Not researched in depth; see the comments on the real issue for the actual thread.`,
    sources: [{ kind: "issue", ref: `#${i.number}`, title: i.title, author: i.user, at: i.created_at }],
    children: [],
  };
}

function askFromPr(p: PrRow): Rung {
  const outcome = p.merged_at ? "merged" : p.state === "closed" ? "closed without merging" : "open";
  return {
    path: `asks/${p.number}`,
    kind: "ask",
    summary: `${p.user} ASKs to merge: "${p.title}" (${outcome}). Not researched in depth; see the real PR for its actual diff and review.`,
    sources: [{ kind: "pr", ref: `#${p.number}`, title: p.title, author: p.user, at: p.created_at }],
    children: [],
  };
}

function releaseRung(r: ReleaseRow): Rung {
  const firstLine = (r.body ?? "").split("\n").find((l) => l.trim().length > 0) ?? "(no release notes)";
  const sha = resolveTagCommit(repoDir, r.tag_name);
  return {
    path: `releases/${r.tag_name}`,
    kind: "release",
    summary: `${r.tag_name}, published ${r.published_at}. ${firstLine}`,
    sources: [{ kind: "commit", ref: sha, title: r.tag_name, author: r.author ?? "unknown", at: r.published_at }],
    children: [],
  };
}

// What we already know specifically about a contributor from the file-level
// rungs built by hand; everyone else just gets their real, un-elaborated
// GitHub contribution count rather than an invented summary.
const KNOWN_WORK: Record<string, string> = {
  tj: "founding author (as TJ Holowaychuk): wrote the original index.js, lib/test.js, and the del/delete verb handling.",
  titanism: "the most active recent maintainer: the September 2026 ephemeral-server stabilization, the superagent v10 compatibility work, the #651 fix-then-revert-then-refix saga, and the #798 superagent pin.",
  lamweili: "added http2 support (index.js, lib/test.js, lib/agent.js) and decoupled TestAgent from superagent's Agent internals.",
  jimmywarting: "converted Test to a class, moved requires to the top of files, and the var-to-const cleanup across lib/test.js and lib/agent.js.",
  mikelax: "PR #477, updating dev dependencies.",
};

function contributorRung(c: ContributorRow): Rung {
  const known = KNOWN_WORK[c.login];
  const summary = known
    ? `${c.login}: ${c.contributions} real commits. Specifically: ${known}`
    : `${c.login}: ${c.contributions} real commits. Not individually researched beyond the real contribution count.`;
  return { path: `contributors/${c.login}`, kind: "contributor", summary, sources: [], children: [] };
}

// Dependency descriptions here are hand-written because they cite the
// specific real call sites (index.js, lib/agent.js, the .contain()
// assertion) the file-level rungs already established; engine/ingest.ts's
// parseDependencies() gives the real name/version pairs generically, this
// just adds the specific knowledge on top for this one repo.
const dependencyRungs: Rung[] = [
  {
    path: "dependencies/superagent",
    kind: "dependencies",
    summary: "superagent (^10.3.0): the HTTP client supertest wraps every request in. Onboarded separately as its own repo.",
    sources: [],
    children: [],
  },
  {
    path: "dependencies/methods",
    kind: "dependencies",
    summary: "methods (^1.1.2): the list of HTTP verb names index.js and lib/agent.js iterate over to build one method per verb.",
    sources: [],
    children: [],
  },
  {
    path: "dependencies/cookie-signature",
    kind: "dependencies",
    summary: "cookie-signature (^1.2.2): verifies signed cookie values in lib/cookies/assertion.js's .contain() assertion.",
    sources: [],
    children: [],
  },
  {
    // engine/ingest.ts's fetchDependentsSummary() returns null for every
    // repo: GitHub's dependents graph has no API, only a web page. This
    // specific number was pulled by hand via a one-off page fetch and is
    // recorded here as this repo's known value, not generated by anything
    // re-runnable.
    path: "dependents",
    kind: "dependencies",
    summary:
      "Real aggregate counts from GitHub's own dependency graph (network/dependents), not an enumerated list: approximately 1,741,617 dependent repositories and 32,731 dependent packages.",
    sources: [],
    children: [],
  },
];

async function main() {
  const issues = fetchIssues(REPO).filter((i) => !SKIP_ISSUES.has(i.number));
  const prs = fetchPullRequests(REPO);
  const releases = fetchReleases(REPO).filter((r) => !SKIP_RELEASES.has(r.tag_name));
  const contributors = fetchContributors(REPO);

  const askRungs = [...issues.map(askFromIssue), ...prs.map(askFromPr)];
  const releaseRungs = releases.map(releaseRung);
  const contributorRungs = contributors.map(contributorRung);

  console.log(`writing ${askRungs.length} asks (${issues.length} issues + ${prs.length} PRs), ${releaseRungs.length} releases, ${contributorRungs.length} contributors, ${dependencyRungs.length} dependency rungs...`);

  const all = [...askRungs, ...releaseRungs, ...contributorRungs, ...dependencyRungs];
  let done = 0;
  for (const rung of all) {
    await writeLadder(repoDir, stateDir, rung);
    done += 1;
    if (done % 100 === 0) console.log(`  ${done}/${all.length}`);
  }

  await appendRepoChildren(
    repoDir,
    stateDir,
    all.map((r) => ({ path: r.path, kind: r.kind as RungKind })),
  );

  console.log(`done: ${all.length} top-level rungs present under the repo root.`);
}

await main();
