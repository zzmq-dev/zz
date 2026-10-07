// Bulk onboarding pass for supertest: the real scale the hand-built
// ladder-full-supertest.ts deliberately didn't attempt (619 issues, 290
// PRs, 47 releases, 92 contributors). Lightweight by design: one real
// title/author/date per item, no deep comment-thread research the way
// asks/798 and asks/651 got. Run ladder-full-supertest.ts first; this
// extends what it wrote rather than replacing it, and skips the two
// issues and the one release already covered there in depth.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rung, RungKind } from "../engine/ladder.js";
import { appendRepoChildren, writeLadder } from "../engine/ladderNotes.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, "..", "demo-repos", "supertest");
const stateDir = join(here, "..", "state", "supertest");
const REPO = "forwardemail/supertest";

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function ghJsonLines<T>(apiPath: string, jq: string): T[] {
  const raw = gh(["api", apiPath, "--paginate", "--jq", jq]);
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

// --- fetch real data -------------------------------------------------

interface IssueRow {
  number: number;
  title: string;
  state: string;
  user: string;
  created_at: string;
  closed_at: string | null;
  comments: number;
}
const SKIP_ISSUES = new Set([651, 798]); // already covered in depth
const issues = ghJsonLines<IssueRow>(
  `repos/${REPO}/issues?state=all&per_page=100`,
  ".[] | select(.pull_request == null) | {number, title, state, user: .user.login, created_at, closed_at, comments}",
).filter((i) => !SKIP_ISSUES.has(i.number));

interface PrRow {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  user: string;
  created_at: string;
  closed_at: string | null;
}
const prs = ghJsonLines<PrRow>(
  `repos/${REPO}/pulls?state=all&per_page=100`,
  ".[] | {number, title, state, merged_at, user: .user.login, created_at, closed_at}",
);

interface ReleaseRow {
  tag_name: string;
  published_at: string;
  author: string;
  body: string | null;
}
const SKIP_RELEASES = new Set(["v6.3.1"]); // already covered in depth
const releases = ghJsonLines<ReleaseRow>(`repos/${REPO}/releases?per_page=100`, ".[] | {tag_name, published_at, author: .author.login, body}").filter(
  (r) => !SKIP_RELEASES.has(r.tag_name),
);

interface ContributorRow {
  login: string;
  contributions: number;
}
const contributors = ghJsonLines<ContributorRow>(`repos/${REPO}/contributors?per_page=100`, ".[] | {login, contributions}");

// --- build rungs -------------------------------------------------------

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
  const sha = execFileSync("git", ["-C", repoDir, "rev-parse", `${r.tag_name}^{commit}`], { encoding: "utf8" }).trim();
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
  return {
    path: `contributors/${c.login}`,
    kind: "contributor",
    summary,
    sources: [],
    children: [],
  };
}

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
    path: "dependents",
    kind: "dependencies",
    summary:
      "Real aggregate counts from GitHub's own dependency graph (network/dependents), not an enumerated list: approximately 1,741,617 dependent repositories and 32,731 dependent packages.",
    sources: [],
    children: [],
  },
];

// --- write ---------------------------------------------------------------

async function main() {
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

  console.log(`done: ${all.length} new top-level rungs added to the repo root.`);
}

await main();
