// `zz ladder build <owner/repo>`: runs the ingest pipeline (engine/
// ingest.ts) against any repo, including the content-summarization pass
// (engine/summarize.ts) -- every file, ask, contributor, and dependency
// gets a summary of what it actually is, not a stub saying it wasn't
// looked at.
import * as git from "isomorphic-git";
import fs from "node:fs";
import { ensureCloned, resolveRepo } from "../lib/repo.js";
import {
  fetchContributorCommitMessages,
  fetchContributors,
  fetchDependentsSummary,
  fetchIssues,
  fetchPullRequests,
  fetchReleases,
  fetchThreadComments,
  findDependencyUsage,
  parseDependencies,
  resolveTagCommit,
  walkFileTree,
  type ContributorRow,
  type IssueRow,
  type PrRow,
  type ReleaseRow,
} from "../../engine/ingest.js";
import { createLimiter, summarizeContributor, summarizeDependencyUsage, summarizeThread, warmUp } from "../../engine/summarize.js";
import type { Rung, RungKind } from "../../engine/ladder.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { appendRepoChildren, readAnchor, writeLadder } from "../../engine/ladderNotes.js";

export interface BuildOptions {
  force?: boolean;
}

const limit = createLimiter(5);

async function askFromIssue(slug: string, i: IssueRow): Promise<Rung> {
  const outcome = i.state === "closed" ? "closed" : "open";
  const comments = fetchThreadComments(slug, i.number);
  const summary = await summarizeThread({ kind: "issue", number: i.number, title: i.title, body: i.body ?? "", state: i.state, mergedOrClosed: outcome, comments });
  return {
    path: `asks/${i.number}`,
    kind: "ask",
    summary,
    sources: [{ kind: "issue", ref: `#${i.number}`, title: i.title, author: i.user, at: i.created_at }],
    children: [],
  };
}

async function askFromPr(slug: string, p: PrRow): Promise<Rung> {
  const outcome = p.merged_at ? "merged" : p.state === "closed" ? "closed without merging" : "open";
  const comments = fetchThreadComments(slug, p.number);
  const summary = await summarizeThread({ kind: "pr", number: p.number, title: p.title, body: p.body ?? "", state: p.state, mergedOrClosed: outcome, comments });
  return {
    path: `asks/${p.number}`,
    kind: "ask",
    summary,
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

async function contributorRung(slug: string, c: ContributorRow): Promise<Rung> {
  const messages = fetchContributorCommitMessages(slug, c.login);
  const summary = await summarizeContributor(c.login, messages);
  return {
    path: `contributors/${c.login}`,
    kind: "contributor",
    summary: `${c.login}: ${c.contributions} commits. ${summary}`,
    sources: [],
    children: [],
  };
}

async function dependencyRung(repoDir: string, name: string, versionRange: string): Promise<Rung> {
  const usage = findDependencyUsage(repoDir, name);
  const summary = await summarizeDependencyUsage(name, usage);
  return { path: `dependencies/${name}`, kind: "dependencies", summary: `${name} (${versionRange}). ${summary}`, sources: [], children: [] };
}

async function isPresent(repoDir: string, stateDir: string, path: string): Promise<boolean> {
  return (await readAnchor(repoDir, stateDir, path)) !== null;
}

/** Filters out items that already have a note, so the summarization pass below never spends a `claude -p` call on something that will just be thrown away -- and never overwrites hand-enriched content. */
async function keepMissing<T>(repoDir: string, stateDir: string, items: T[], pathOf: (item: T) => string, force: boolean | undefined): Promise<T[]> {
  if (force) return items;
  const keep: T[] = [];
  for (const item of items) {
    if (!(await isPresent(repoDir, stateDir, pathOf(item)))) keep.push(item);
  }
  return keep;
}

export async function ladderBuild(slug: string, options: BuildOptions): Promise<void> {
  const repo = resolveRepo(slug);
  ensureCloned(repo);
  warmUp();

  const rootAlreadyBuilt = (await readAnchor(repo.repoDir, repo.stateDir, REPO_RUNG_PATH)) !== null;
  if (!rootAlreadyBuilt || options.force) {
    console.error("walking the file tree and summarizing each file (this calls `claude -p` per file, so it takes a while)...");
    const fileTree = await walkFileTree(repo.repoDir, (done, total) => {
      if (done % 10 === 0 || done === total) console.error(`  files: ${done}/${total}`);
    });
    const headCommits = await git.log({ fs, dir: repo.repoDir, depth: 1 });
    const root: Rung = {
      path: REPO_RUNG_PATH,
      kind: "repo",
      summary: `${repo.slug}. Onboarded via \`zz ladder build\`; no top-level narrative summary written yet.`,
      sources: headCommits[0]
        ? [{ kind: "commit", ref: headCommits[0].oid.slice(0, 7), title: headCommits[0].commit.message.split("\n")[0], author: headCommits[0].commit.author.name, at: new Date(headCommits[0].commit.author.timestamp * 1000).toISOString() }]
        : [],
      children: fileTree,
    };
    await writeLadder(repo.repoDir, repo.stateDir, root);
    console.error(`wrote the repo root and ${fileTree.length} top-level file/directory rungs.`);
  } else {
    console.error("repo root already has a note; leaving the file tree alone (pass --force to rebuild it).");
  }

  console.error("fetching issues, PRs, releases, contributors...");
  const allIssues = fetchIssues(repo.slug);
  const allPrs = fetchPullRequests(repo.slug);
  const allReleases = fetchReleases(repo.slug);
  const allContributors = fetchContributors(repo.slug);
  const dependents = fetchDependentsSummary(repo.slug);
  const allDependencies = parseDependencies(repo.repoDir);

  // Drop anything that already has a note before paying for a `claude -p`
  // call on it -- it would just be thrown away, and for a repo with
  // hand-enriched content this is what keeps a generic rebuild from
  // overwriting it.
  const { repoDir, stateDir } = repo;
  const issues = await keepMissing(repoDir, stateDir, allIssues, (i) => `asks/${i.number}`, options.force);
  const prs = await keepMissing(repoDir, stateDir, allPrs, (p) => `asks/${p.number}`, options.force);
  const releases = await keepMissing(repoDir, stateDir, allReleases, (r) => `releases/${r.tag_name}`, options.force);
  const contributors = await keepMissing(repoDir, stateDir, allContributors, (c) => `contributors/${c.login}`, options.force);
  const dependencies = await keepMissing(repoDir, stateDir, allDependencies, (d) => `dependencies/${d.name}`, options.force);

  const skipped = allIssues.length + allPrs.length + allReleases.length + allContributors.length + allDependencies.length - issues.length - prs.length - releases.length - contributors.length - dependencies.length;
  console.error(`summarizing ${issues.length + prs.length} ask threads, ${contributors.length} contributors, ${dependencies.length} dependencies (${skipped} already onboarded, skipped)...`);

  const asks = await Promise.all([...issues.map((i) => limit(() => askFromIssue(repo.slug, i))), ...prs.map((p) => limit(() => askFromPr(repo.slug, p)))]);
  const releaseRungs = releases.map((r) => releaseRung(repo.repoDir, r));
  const contributorRungs = await Promise.all(contributors.map((c) => limit(() => contributorRung(repo.slug, c))));
  const dependencyRungs = await Promise.all(dependencies.map((d) => limit(() => dependencyRung(repo.repoDir, d.name, d.versionRange))));
  if (dependents && !(await isPresent(repoDir, stateDir, "dependents"))) {
    dependencyRungs.push({ path: "dependents", kind: "dependencies", summary: dependents, sources: [], children: [] });
  }

  const all = [...asks, ...releaseRungs, ...contributorRungs, ...dependencyRungs];
  for (const rung of all) {
    await writeLadder(repo.repoDir, repo.stateDir, rung);
  }
  await appendRepoChildren(repo.repoDir, repo.stateDir, all.map((r) => ({ path: r.path, kind: r.kind as RungKind })));

  console.error(`done: ${all.length} new rungs written, ${skipped} already present and left alone.`);
}
