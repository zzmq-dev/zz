// `zz ladder build <owner/repo>`: onboards a repo by replaying its
// history through the real Lane/ASK/ANSWER protocol (engine/lane.ts),
// not by writing Ladder rungs directly. One local agent (configurable
// id, default "zz-local") plays both sides of the protocol -- it's the
// single actor in the system for this bootstrap step, holding
// Coordinator-level access by construction (no role-grant ceremony yet,
// see the plan). Any content analysis goes through a local Ollama model
// (engine/model.ts); nothing here ever shells out to another CLI.
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
import { resolveModelBackend, type ModelBackend } from "../../engine/model.js";
import type { Provider } from "../lib/resolveChatBackend.js";
import { ask, answer, mergeLaneLadder, proposeLane } from "../../engine/lane.js";
import type { Rung } from "../../engine/ladder.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { readAnchor } from "../../engine/ladderNotes.js";
import { readLane } from "../../engine/store.js";
import type { LaneRef } from "../../engine/types.js";

export interface BuildOptions {
  force?: boolean;
  /** Same meaning as zz work's own --provider/--model: ollama (default, needs nothing else running) or gemini/groq/cloudflare (needs that provider's own API key). */
  provider?: Provider;
  model?: string;
}

const AGENT = process.env.ZZ_AGENT ?? "zz-local";
// Same identity ladder-replay-commits.ts uses for the repo Lane's own
// coordinator -- both commands touch the same `_repo` Lane, and whoever
// creates it first fixes its `coordinators` list, so they need to agree.
const COORDINATOR = process.env.ZZ_COORDINATOR ?? "zz-coordinator";

/**
 * Runs one history item through the real protocol: propose, claim
 * (ask+answer), do the work, ask to merge (ask+answer), merge. The same
 * agent plays both sides -- this is the bootstrap single-actor case the
 * plan describes, not a shortcut around the protocol.
 */
export async function runItemLane(
  repoDir: string,
  stateDir: string,
  input: { id: string; repo: string; name: string; objective: string; scope: string[]; origin: LaneRef },
  doWork: () => Promise<Rung | Rung[]>,
): Promise<void> {
  const lane = await proposeLane(input.repo, { ...input, proposedBy: AGENT });
  const claim = await ask(input.repo, lane.id, { kind: "claim_request", from: AGENT });
  await answer(input.repo, lane.id, claim, { from: AGENT, action: "grant" });

  const laneLadder = await doWork();

  const mergeRequest = await ask(input.repo, lane.id, { kind: "merge_request", from: AGENT });
  await answer(input.repo, lane.id, mergeRequest, { from: AGENT, action: "grant" });
  await mergeLaneLadder(input.repo, laneLadder);
}

export async function isPresent(repoDir: string, stateDir: string, path: string): Promise<boolean> {
  return (await readAnchor(repoDir, stateDir, path)) !== null;
}

function askPrompt(input: { kind: "issue" | "pr"; number: number; title: string; author: string; body: string; outcome: string; comments: { author: string; body: string }[] }): string {
  const thread = input.comments.map((c) => `${c.author}: ${c.body}`).join("\n---\n");
  return `Describe in 2-4 sentences what this GitHub ${input.kind} asked for and what happened (outcome: ${input.outcome}). Be concrete about the technical content, not a restatement of the title. Use only the names given below -- never invent a username.

#${input.number} (opened by ${input.author}): ${input.title}
${input.body || "(no body)"}

Thread:
${thread || "(no comments)"}
---
Summary:`;
}

export async function buildAskFromIssue(repoDir: string, stateDir: string, origin: LaneRef, slug: string, model: ModelBackend, i: IssueRow): Promise<void> {
  const path = `asks/${i.number}`;
  if (await isPresent(repoDir, stateDir, path)) return;
  const outcome = i.state === "closed" ? "closed" : "open";
  await runItemLane(repoDir, stateDir, { id: `ask-${i.number}`, repo: slug, name: `onboard issue #${i.number}`, objective: i.title, scope: [path], origin }, async () => {
    const comments = fetchThreadComments(slug, i.number);
    const summary = (await model.summarize(askPrompt({ kind: "issue", number: i.number, title: i.title, author: i.user, body: i.body ?? "", outcome, comments }))) ?? `${i.user}: "${i.title}" (${outcome}, ${i.comments} comments).`;
    return { path, kind: "ask", summary, sources: [{ kind: "issue", ref: `#${i.number}`, title: i.title, author: i.user, at: i.created_at }], children: [] };
  });
}

export async function buildAskFromPr(repoDir: string, stateDir: string, origin: LaneRef, slug: string, model: ModelBackend, p: PrRow): Promise<void> {
  const path = `asks/${p.number}`;
  if (await isPresent(repoDir, stateDir, path)) return;
  const outcome = p.merged_at ? "merged" : p.state === "closed" ? "closed without merging" : "open";
  await runItemLane(repoDir, stateDir, { id: `ask-${p.number}`, repo: slug, name: `onboard PR #${p.number}`, objective: p.title, scope: [path], origin }, async () => {
    const comments = fetchThreadComments(slug, p.number);
    const summary = (await model.summarize(askPrompt({ kind: "pr", number: p.number, title: p.title, author: p.user, body: p.body ?? "", outcome, comments }))) ?? `${p.user}: "${p.title}" (${outcome}).`;
    return { path, kind: "ask", summary, sources: [{ kind: "pr", ref: `#${p.number}`, title: p.title, author: p.user, at: p.created_at }], children: [] };
  });
}

export async function buildRelease(repoDir: string, stateDir: string, origin: LaneRef, slug: string, r: ReleaseRow): Promise<void> {
  const path = `releases/${r.tag_name}`;
  if (await isPresent(repoDir, stateDir, path)) return;
  await runItemLane(repoDir, stateDir, { id: `release-${r.tag_name}`, repo: slug, name: `onboard release ${r.tag_name}`, objective: r.tag_name, scope: [path], origin }, async () => {
    const firstLine = (r.body ?? "").split("\n").find((l) => l.trim().length > 0) ?? "(no release notes)";
    const sha = resolveTagCommit(repoDir, r.tag_name);
    return { path, kind: "release", summary: `${r.tag_name}, published ${r.published_at}. ${firstLine}`, sources: [{ kind: "commit", ref: sha, title: r.tag_name, author: r.author ?? "unknown", at: r.published_at }], children: [] };
  });
}

export async function buildContributor(repoDir: string, stateDir: string, origin: LaneRef, slug: string, model: ModelBackend, c: ContributorRow): Promise<void> {
  const path = `contributors/${c.login}`;
  if (await isPresent(repoDir, stateDir, path)) return;
  await runItemLane(repoDir, stateDir, { id: `contributor-${c.login}`, repo: slug, name: `onboard contributor ${c.login}`, objective: c.login, scope: [path], origin }, async () => {
    const messages = fetchContributorCommitMessages(slug, c.login);
    const prompt = `Describe in 1-2 sentences the specific areas or kinds of changes this contributor made, based on their commit messages below.\n\nContributor: ${c.login}\nCommit messages:\n${messages.slice(0, 60).join("\n")}\n---\nSummary:`;
    const described = messages.length ? await model.summarize(prompt) : null;
    const summary = `${c.login}: ${c.contributions} commits.${described ? ` ${described}` : ""}`;
    return { path, kind: "contributor", summary, sources: [], children: [] };
  });
}

export async function buildDependency(repoDir: string, stateDir: string, origin: LaneRef, slug: string, model: ModelBackend, name: string, versionRange: string): Promise<void> {
  const path = `dependencies/${name}`;
  if (await isPresent(repoDir, stateDir, path)) return;
  await runItemLane(repoDir, stateDir, { id: `dependency-${name}`, repo: slug, name: `onboard dependency ${name}`, objective: name, scope: [path], origin }, async () => {
    const usage = findDependencyUsage(repoDir, name);
    const snippetText = usage.slice(0, 20).map((s) => `${s.file}: ${s.line.trim()}`).join("\n");
    const described = usage.length ? await model.summarize(`Describe in 1-2 sentences how this dependency is used in this codebase, based on the source lines below.\n\nDependency: ${name}\nUsage sites:\n${snippetText}\n---\nSummary:`) : null;
    const summary = `${name} (${versionRange}).${described ? ` ${described}` : " No usage sites found by search."}`;
    return { path, kind: "dependencies", summary, sources: [], children: [] };
  });
}

/** The repo's own long-lived Lane: proposed once, transitioned to active, and never merged -- everything onboarded under a repo (the file tree, every ask/release/contributor/dependency, and ladder-sync.ts's own re-summarize-a-changed-file writes) has it as origin. Idempotent: a second call (ladder-sync.ts, run against an already-built repo) finds the existing Lane via readLane and reuses it rather than proposing a duplicate. */
export async function resolveRepoLaneOrigin(slug: string, stateDir: string): Promise<LaneRef> {
  let repoLane = readLane(stateDir, REPO_RUNG_PATH);
  if (!repoLane) {
    repoLane = await proposeLane(slug, { id: REPO_RUNG_PATH, repo: slug, name: slug, objective: `the ${slug} repository`, scope: ["**"], proposedBy: COORDINATOR, coordinators: [COORDINATOR] });
    const review = await ask(slug, repoLane.id, { kind: "review_request", from: AGENT });
    await answer(slug, repoLane.id, review, { from: COORDINATOR, action: "grant" });
  }
  return { repo: slug, lane: repoLane.id };
}

export async function ladderBuild(slug: string, options: BuildOptions): Promise<void> {
  const repo = resolveRepo(slug);
  ensureCloned(repo);
  const model = await resolveModelBackend(options.provider, options.model);
  console.error(`model backend: ${model.name}`);

  const origin = await resolveRepoLaneOrigin(slug, repo.stateDir);

  const repoAlreadyPresent = await isPresent(repo.repoDir, repo.stateDir, REPO_RUNG_PATH);
  if (!repoAlreadyPresent || options.force) {
    console.error("describing the file tree (one Lane for the whole tree; a model call per file)...");
    let done = 0;
    await runItemLane(repo.repoDir, repo.stateDir, { id: "file-tree", repo: slug, name: "describe the file tree", objective: "describe every tracked file and directory", scope: ["**"], origin }, async () => {
      const topLevel = await walkFileTree(repo.repoDir, async (path, content, mechanical) => {
        done += 1;
        if (done % 5 === 0) console.error(`  files: ${done}`);
        if (!content.trim()) return mechanical;
        const described = await model.summarize(`Describe in 1-3 sentences what this file does, based on its content below. Name exported functions/classes by name.\n\nFile: ${path}\n---\n${content.slice(0, 6000)}\n---\nSummary:`);
        return described ?? mechanical;
      });
      // Only the very first build writes "_repo" itself -- its own
      // summary is a static string that never needs updating, and
      // mergeLaneLadder/writeLadder overwrite a rung's children
      // wholesale, not merge them. Including a fresh, empty-children
      // root in this SAME batch on a --force rebuild of an
      // already-onboarded repo would wipe out every ask/release/
      // contributor/dependency path already appended to it since
      // (confirmed live: it did, until this check existed) --
      // topLevel alone still gets correctly appended either way via
      // mergeLaneLadder's own appendRepoChildren call.
      if (repoAlreadyPresent) return topLevel;
      const root: Rung = { path: REPO_RUNG_PATH, kind: "repo", summary: `${slug}, onboarded via \`zz ladder build\`.`, sources: [], children: [] };
      return [root, ...topLevel];
    });
  } else {
    console.error("file tree already onboarded; leaving it alone (pass --force to rebuild it).");
  }

  console.error("fetching issues, PRs, releases, contributors, dependencies...");
  const issues = fetchIssues(repo.slug);
  const prs = fetchPullRequests(repo.slug);
  const releases = fetchReleases(repo.slug);
  const contributors = fetchContributors(repo.slug);
  const dependencies = parseDependencies(repo.repoDir);
  const dependents = fetchDependentsSummary(repo.slug);

  for (const i of issues) await buildAskFromIssue(repo.repoDir, repo.stateDir, origin, repo.slug, model, i);
  for (const p of prs) await buildAskFromPr(repo.repoDir, repo.stateDir, origin, repo.slug, model, p);
  for (const r of releases) await buildRelease(repo.repoDir, repo.stateDir, origin, repo.slug, r);
  for (const c of contributors) await buildContributor(repo.repoDir, repo.stateDir, origin, repo.slug, model, c);
  for (const d of dependencies) await buildDependency(repo.repoDir, repo.stateDir, origin, repo.slug, model, d.name, d.versionRange);
  if (dependents && !(await isPresent(repo.repoDir, repo.stateDir, "dependents"))) {
    await runItemLane(repo.repoDir, repo.stateDir, { id: "dependents", repo: repo.slug, name: "onboard dependents", objective: "dependents", scope: ["dependents"], origin }, async () => ({
      path: "dependents",
      kind: "dependencies",
      summary: dependents,
      sources: [],
      children: [],
    }));
  }

  console.error("done.");
}
