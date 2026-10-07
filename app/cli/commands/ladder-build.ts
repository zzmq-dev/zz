// `zz ladder build <owner/repo>`: runs the real, generic ingest pipeline
// (engine/ingest.ts) against any repo. Deliberately mechanical where
// ladder-full-supertest.ts is hand-researched: real file list, real commit
// counts, real issues/PRs/releases/contributors, no narrative understanding
// of what any function actually does. See engine/ingest.ts's header for
// why that split is real, not a shortcut.
import * as git from "isomorphic-git";
import fs from "node:fs";
import { ensureCloned, resolveRepo } from "../lib/repo.js";
import {
  fetchContributors,
  fetchDependentsSummary,
  fetchIssues,
  fetchPullRequests,
  fetchReleases,
  parseDependencies,
  resolveTagCommit,
  walkFileTree,
  type ContributorRow,
  type IssueRow,
  type PrRow,
  type ReleaseRow,
} from "../../engine/ingest.js";
import type { Rung, RungKind } from "../../engine/ladder.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { appendRepoChildren, readAnchor, writeLadder } from "../../engine/ladderNotes.js";

export interface BuildOptions {
  force?: boolean;
}

function askFromIssue(i: IssueRow): Rung {
  const outcome = i.state === "closed" ? "closed" : "open";
  return {
    path: `asks/${i.number}`,
    kind: "ask",
    summary: `${i.user} asks: "${i.title}" (${outcome}, ${i.comments} comments). Not researched in depth.`,
    sources: [{ kind: "issue", ref: `#${i.number}`, title: i.title, author: i.user, at: i.created_at }],
    children: [],
  };
}

function askFromPr(p: PrRow): Rung {
  const outcome = p.merged_at ? "merged" : p.state === "closed" ? "closed without merging" : "open";
  return {
    path: `asks/${p.number}`,
    kind: "ask",
    summary: `${p.user} asks to merge: "${p.title}" (${outcome}). Not researched in depth.`,
    sources: [{ kind: "pr", ref: `#${p.number}`, title: p.title, author: p.user, at: p.created_at }],
    children: [],
  };
}

function releaseRung(repoDir: string, r: ReleaseRow): Rung {
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

function contributorRung(c: ContributorRow): Rung {
  return {
    path: `contributors/${c.login}`,
    kind: "contributor",
    summary: `${c.login}: ${c.contributions} commits. Not individually researched.`,
    sources: [],
    children: [],
  };
}

/** Writes an anchor unless it already has a note, protecting any hand-enriched content a generic rebuild would otherwise clobber. */
async function writeUnlessPresent(repoDir: string, stateDir: string, rung: Rung, force: boolean | undefined): Promise<boolean> {
  if (!force) {
    const existing = await readAnchor(repoDir, stateDir, rung.path);
    if (existing) return false;
  }
  await writeLadder(repoDir, stateDir, rung);
  return true;
}

export async function ladderBuild(slug: string, options: BuildOptions): Promise<void> {
  const repo = resolveRepo(slug);
  ensureCloned(repo);

  const rootAlreadyBuilt = (await readAnchor(repo.repoDir, repo.stateDir, REPO_RUNG_PATH)) !== null;
  if (!rootAlreadyBuilt || options.force) {
    console.error("walking the real file tree...");
    const fileTree = await walkFileTree(repo.repoDir);
    const headCommits = await git.log({ fs, dir: repo.repoDir, depth: 1 });
    const root: Rung = {
      path: REPO_RUNG_PATH,
      kind: "repo",
      summary: `${repo.slug}. Onboarded mechanically; no narrative summary yet.`,
      sources: headCommits[0] ? [{ kind: "commit", ref: headCommits[0].oid.slice(0, 7), title: headCommits[0].commit.message.split("\n")[0], author: headCommits[0].commit.author.name, at: new Date(headCommits[0].commit.author.timestamp * 1000).toISOString() }] : [],
      children: fileTree,
    };
    await writeLadder(repo.repoDir, repo.stateDir, root);
    console.error(`wrote the repo root and ${fileTree.length} top-level file/directory rungs.`);
  } else {
    console.error("repo root already has a note; leaving the file tree alone (pass --force to rebuild it).");
  }

  console.error("fetching issues, PRs, releases, contributors...");
  const issues = fetchIssues(repo.slug);
  const prs = fetchPullRequests(repo.slug);
  const releases = fetchReleases(repo.slug);
  const contributors = fetchContributors(repo.slug);
  const dependents = fetchDependentsSummary(repo.slug);

  const asks = [...issues.map(askFromIssue), ...prs.map(askFromPr)];
  const releaseRungs = releases.map((r) => releaseRung(repo.repoDir, r));
  const contributorRungs = contributors.map(contributorRung);
  const dependencyRungs: Rung[] = parseDependencies(repo.repoDir).map((d) => ({
    path: `dependencies/${d.name}`,
    kind: "dependencies" as const,
    summary: `${d.name} (${d.versionRange}). Not individually described.`,
    sources: [],
    children: [],
  }));
  if (dependents) {
    dependencyRungs.push({ path: "dependents", kind: "dependencies", summary: dependents, sources: [], children: [] });
  }

  const all = [...asks, ...releaseRungs, ...contributorRungs, ...dependencyRungs];
  let written = 0;
  for (const rung of all) {
    if (await writeUnlessPresent(repo.repoDir, repo.stateDir, rung, options.force)) written += 1;
  }
  await appendRepoChildren(repo.repoDir, repo.stateDir, all.map((r) => ({ path: r.path, kind: r.kind as RungKind })));

  console.error(`done: ${written} new rungs written, ${all.length - written} already present and left alone.`);
}
