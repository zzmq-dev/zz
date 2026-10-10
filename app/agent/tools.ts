// The in-process tool catalog from site/content/mcp/index.md: zz-git and
// zz-ladder-lanes. Every tool is a thin wrapper over an existing engine
// function -- no new business logic here. Judgment (is a change
// material, how to decompose a task, when work is done) stays in the
// calling agent's own reasoning, never inside a tool.
import { randomBytes } from "node:crypto";
import { ensureCloned, resolveRepo } from "../cli/lib/repo.js";
import {
  commitFileChanges,
  fetchContributors,
  fetchIssues,
  fetchPullRequests,
  fetchReleases,
  fetchThreadComments,
  fileContentAtCommit,
  listCommitsChronological,
} from "../engine/ingest.js";
import { ask, answer, mergeLaneLadder, proposeLane } from "../engine/lane.js";
import { claimableAsks } from "../engine/workqueue.js";
import { readAnchor } from "../engine/ladderNotes.js";
import { readLane } from "../engine/store.js";
import { resolveModelBackend } from "../engine/model.js";
import { commitChangeset, type ChangesetFile } from "../engine/changeset.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rung } from "../engine/ladder.js";
import type { AskEntry, AskKind, LaneRef } from "../engine/types.js";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function requireAsk(lane: ReturnType<typeof readLane>, askId: string): AskEntry {
  if (!lane) throw new Error("no such lane");
  const found = lane.history.find((e) => e.type === "ASK" && e.id === askId);
  if (!found) throw new Error(`no such ask: ${askId}`);
  return found as AskEntry;
}

// --- zz-git: read-only data fetching, nothing writes anything ----------

const gitLog: ToolDef = {
  name: "git_log",
  description: "List every commit on the repo's default branch, oldest first (first-parent only).",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  async execute({ repo }) {
    const r = resolveRepo(repo as string);
    ensureCloned(r);
    return listCommitsChronological(r.repoDir);
  },
};

const gitDiff: ToolDef = {
  name: "git_diff",
  description: "What changed in one commit: which files, how (added/modified/deleted), and the diff hunks for modified files.",
  parameters: { type: "object", properties: { repo: { type: "string" }, sha: { type: "string" } }, required: ["repo", "sha"] },
  async execute({ repo, sha }) {
    const r = resolveRepo(repo as string);
    const commits = listCommitsChronological(r.repoDir);
    const commit = commits.find((c) => c.sha === sha);
    if (!commit) throw new Error(`no such commit: ${sha}`);
    return commitFileChanges(r.repoDir, commit);
  },
};

const gitShowFile: ToolDef = {
  name: "git_show_file",
  description: "A file's full content as of a specific commit.",
  parameters: { type: "object", properties: { repo: { type: "string" }, sha: { type: "string" }, path: { type: "string" } }, required: ["repo", "sha", "path"] },
  async execute({ repo, sha, path }) {
    const r = resolveRepo(repo as string);
    return fileContentAtCommit(r.repoDir, sha as string, path as string);
  },
};

const ghFetchIssues: ToolDef = {
  name: "gh_fetch_issues",
  description: "Every issue on the repo's GitHub page (title, state, author, comment count, body).",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  async execute({ repo }) {
    return fetchIssues(repo as string);
  },
};

const ghFetchPullRequests: ToolDef = {
  name: "gh_fetch_pull_requests",
  description: "Every pull request on the repo's GitHub page.",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  async execute({ repo }) {
    return fetchPullRequests(repo as string);
  },
};

const ghFetchReleases: ToolDef = {
  name: "gh_fetch_releases",
  description: "Every GitHub release for the repo.",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  async execute({ repo }) {
    return fetchReleases(repo as string);
  },
};

const ghFetchContributors: ToolDef = {
  name: "gh_fetch_contributors",
  description: "Every contributor GitHub has recorded for the repo, with their commit count.",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  async execute({ repo }) {
    return fetchContributors(repo as string);
  },
};

const ghFetchThreadComments: ToolDef = {
  name: "gh_fetch_thread_comments",
  description: "The comment thread on one issue or PR.",
  parameters: { type: "object", properties: { repo: { type: "string" }, number: { type: "number" } }, required: ["repo", "number"] },
  async execute({ repo, number }) {
    return fetchThreadComments(repo as string, number as number);
  },
};

// --- zz-ladder-lanes: Ask/Answer/Lane/Ladder -----------------------------

const ladderRead: ToolDef = {
  name: "ladder_read",
  description: "Read one rung from the repo's Ladder by path (e.g. \"_repo\", \"index.js\", \"asks/42\"). Returns null if it doesn't exist yet.",
  parameters: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" } }, required: ["repo", "path"] },
  async execute({ repo, path }) {
    const r = resolveRepo(repo as string);
    return readAnchor(r.repoDir, r.stateDir, path as string);
  },
};

const VALID_SOURCE_KINDS = new Set(["commit", "pr", "issue"]);

// Fills in sources/children with [] when omitted, recursively, so a
// slightly incomplete rung from the model doesn't crash deep inside
// ladderNotes.ts with an opaque "reading 'map' of undefined" error.
// Malformed source entries (missing kind or ref) are dropped rather than
// kept with "undefined" fields -- a rung that needed one and only has a
// broken one should hit the clear "no commit source" error below, not
// silently render "undefined" everywhere a title/author/at was missing.
// A string field from the model might arrive as an object ({name,
// email}, say) instead of plain text -- stringify it sensibly rather
// than let it render as the literal text "[object Object]".
function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return String(o.name ?? o.login ?? o.title ?? JSON.stringify(value));
  }
  return String(value);
}

function normalizeRung(rung: unknown): Rung {
  const r = rung as Partial<Rung> & Record<string, unknown>;
  const rawSources = Array.isArray(r.sources) ? r.sources : [];
  const sources = rawSources
    .filter((s): s is NonNullable<typeof s> => !!s && typeof s === "object" && VALID_SOURCE_KINDS.has((s as { kind?: string }).kind ?? "") && !!(s as { ref?: string }).ref)
    .map((s) => ({ kind: s.kind, ref: asText(s.ref), title: asText(s.title), author: asText(s.author), at: asText(s.at) }));
  return {
    path: asText(r.path),
    kind: r.kind as Rung["kind"],
    summary: asText(r.summary),
    sources,
    touches: Array.isArray((r as { touches?: unknown }).touches) ? (r as { touches?: string[] }).touches : undefined,
    children: Array.isArray(r.children) ? r.children.map(normalizeRung) : [],
  };
}

const RUNG_KINDS_NEEDING_A_COMMIT_SOURCE = new Set(["repo", "directory", "file", "release", "changeset"]);
const VALID_TOP_LEVEL_KINDS = new Set(["repo", "directory", "file", "release", "changeset", "ask", "contributor", "dependencies"]);

// Small local models follow a literal example far more reliably than a
// prose description of the right shape -- appended to every validation
// error below so there's always something concrete to copy, not just
// something to interpret.
const VALID_RUNG_EXAMPLE = JSON.stringify({
  path: "changesets/abc123",
  kind: "changeset",
  summary: "Fixed the off-by-one error in the pagination helper.",
  sources: [{ kind: "commit", ref: "abc123def456...", title: "Fix pagination off-by-one", author: "Jane Doe", at: "2026-01-01T00:00:00Z" }],
  children: [{ path: "pagination.js", kind: "filechange", summary: "Changed the loop bound from <= to < to fix the off-by-one.", sources: [], children: [] }],
});

function validateTopLevelKind(rung: Rung): string | null {
  if (!VALID_TOP_LEVEL_KINDS.has(rung.kind)) {
    return `rung "${rung.path}" has kind "${rung.kind}", which can't be written as a top-level rung -- it has no git object of its own to anchor to. Nest it inside its parent's children array instead (e.g. a "filechange" goes inside a "changeset"'s children, not alongside it). Example of a correct call's rung argument: ${VALID_RUNG_EXAMPLE}`;
  }
  return null;
}

function validateAnchorSources(rung: Rung): string | null {
  if (RUNG_KINDS_NEEDING_A_COMMIT_SOURCE.has(rung.kind) && !rung.sources.some((s) => s.kind === "commit" && s.ref)) {
    return `rung "${rung.path}" (kind "${rung.kind}") has no commit source to anchor its note to. Add a sources entry: {kind: "commit", ref: "<the real commit sha this rung is about>", title, author, at}. Example of a correct call's rung argument: ${VALID_RUNG_EXAMPLE}`;
  }
  return null;
}

function validateHasSummary(rung: Rung): string | null {
  if (!rung.summary.trim()) return `rung "${rung.path}" has an empty summary. Every rung needs a real description -- if it shouldn't be there at all, leave it out of children entirely rather than including it with nothing to say. Example of a correct call's rung argument: ${VALID_RUNG_EXAMPLE}`;
  for (const child of rung.children) {
    const problem = validateHasSummary(child);
    if (problem) return problem;
  }
  return null;
}

// A changeset is a historical event (one per commit) and is never
// rewritten. A file/directory/repo/release rung is current-state,
// cumulative by nature -- updating it should describe everything it is
// now, not just the newest change. Relying on the calling agent to
// always remember to ladder_read first and hand-synthesize that is
// unreliable in practice (observed: a file's rung describing only the
// change from several commits ago, with nothing since folded in), so
// this is enforced here, automatically, on every write -- not just
// hoped for via the system prompt.
const CUMULATIVE_SUMMARY_KINDS = new Set(["repo", "directory", "file", "release"]);

async function foldInSummary(existingSummary: string, incomingSummary: string): Promise<string> {
  const model = await resolveModelBackend();
  const synthesized = await model.summarize(
    `You maintain a short, current, holistic description of what something is and does -- not a changelog entry. Below is its existing description and a proposed new one (which may only describe the latest change, not the whole thing). Decide first whether the proposed text actually adds anything the existing description doesn't already cover. If the existing description already covers it, or the difference is purely cosmetic, output the existing description completely unchanged. Otherwise, write ONE updated description that holistically covers everything this currently is/does -- everything the existing description said, plus what's new -- not the new text appended as an extra sentence, and not just a description of the latest change alone.\n\nExisting description: ${existingSummary}\n\nProposed new description: ${incomingSummary}\n\nUpdated description:`,
  );
  if (!synthesized) return `${existingSummary} ${incomingSummary}`;
  // The model sometimes reasons out loud before giving the final text
  // despite the prompt ending with "Updated description:" expecting a
  // direct continuation -- keep only what comes after the last such
  // marker, if present, rather than storing the reasoning preamble too.
  const marker = /updated description:\s*/i;
  const parts = synthesized.split(marker);
  return parts[parts.length - 1].trim() || synthesized.trim();
}

const ladderWriteRung: ToolDef = {
  name: "ladder_write_rung",
  description:
    'Write a rung (or several top-level rungs) into the repo\'s Ladder. The only tool that actually changes stored Ladder state -- use it both to merge a finished changeset/ask/etc and to update a file\'s current-state rung. Only call this if you hold a coordinator role for the Lane whose scope covers this path (see the system prompt). Every rung needs: path, kind, summary, sources (array, [] if none), children (array, [] if none). A rung of kind "repo", "directory", "file", "release", or "changeset" additionally MUST have at least one sources entry shaped {kind: "commit", ref: "<real commit sha>", title, author, at} -- that commit is what its git note gets anchored to.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      rung: {
        description: "A Rung object, or an array of them for several top-level rungs at once.",
        oneOf: [
          {
            type: "object",
            properties: {
              path: { type: "string" },
              kind: { type: "string", enum: ["repo", "directory", "file", "function", "lines", "release", "package", "ask", "answer", "contributor", "dependencies", "changeset", "filechange", "linechange"] },
              summary: { type: "string" },
              sources: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["commit", "pr", "issue"] }, ref: { type: "string" }, title: { type: "string" }, author: { type: "string" }, at: { type: "string" } } } },
              children: { type: "array", items: { type: "object" } },
            },
            required: ["path", "kind", "summary", "sources", "children"],
          },
          { type: "array" },
        ],
      },
    },
    required: ["repo", "rung"],
  },
  async execute({ repo, rung }) {
    const r = resolveRepo(repo as string);
    const rungs = (Array.isArray(rung) ? rung : [rung]).map(normalizeRung);
    for (const one of rungs) {
      const problem = validateTopLevelKind(one) ?? validateAnchorSources(one) ?? validateHasSummary(one);
      if (problem) throw new Error(problem);
    }
    for (const one of rungs) {
      if (!CUMULATIVE_SUMMARY_KINDS.has(one.kind)) continue;
      const existing = await readAnchor(r.repoDir, r.stateDir, one.path);
      if (existing?.summary && existing.summary !== one.summary) {
        one.summary = await foldInSummary(existing.summary, one.summary);
      }
    }
    await mergeLaneLadder(r.repoDir, r.stateDir, rungs);
    return { ok: true, wrote: rungs.map((x) => x.path) };
  },
};

const laneProposeTool: ToolDef = {
  name: "lane_propose",
  description: "Propose a new Lane: a workstream with its own Ask queue and local Ladder. Returns the created Lane, including its generated id.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      name: { type: "string" },
      objective: { type: "string" },
      scope: { type: "array", items: { type: "string" }, description: "Ladder paths this Lane's work covers" },
      origin_lane: { type: "string", description: "The lane id this one originates from, if any" },
      origin_repo: { type: "string", description: "The repo origin_lane lives in, if different from `repo` -- set this for a real cross-repo dependency (e.g. this Lane exists because of a fix in another repo's Lane), not just this repo's own history" },
      actor: { type: "string", description: "Your agent id -- becomes this Lane's coordinator" },
    },
    required: ["repo", "name", "objective", "scope", "actor"],
  },
  async execute({ repo, name, objective, scope, origin_lane, origin_repo, actor }) {
    const r = resolveRepo(repo as string);
    const origin: LaneRef | undefined = origin_lane ? { repo: (origin_repo as string) ?? r.slug, lane: origin_lane as string } : undefined;
    return proposeLane(r.stateDir, {
      id: shortId("lane"),
      repo: r.slug,
      name: name as string,
      objective: objective as string,
      scope: scope as string[],
      proposedBy: actor as string,
      coordinators: [actor as string],
      origin,
    });
  },
};

const laneGet: ToolDef = {
  name: "lane_get",
  description: "Read a Lane's full record: status, scope, coordinators, and its complete Ask/Answer history.",
  parameters: { type: "object", properties: { repo: { type: "string" }, lane_id: { type: "string" } }, required: ["repo", "lane_id"] },
  async execute({ repo, lane_id }) {
    const r = resolveRepo(repo as string);
    return readLane(r.stateDir, lane_id as string);
  },
};

const askPostTool: ToolDef = {
  name: "ask_post",
  description:
    "Post a new Ask into a Lane's queue. Use kind \"work\" with a prose payload.description for anything without a more specific kind. Set depends_on to other ask ids that must be answered before this one may be claimed.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      kind: { type: "string" },
      from: { type: "string" },
      payload: { type: "object" },
      depends_on: { type: "array", items: { type: "string" } },
      priority: { type: "number" },
    },
    required: ["repo", "lane_id", "kind", "from"],
  },
  async execute({ repo, lane_id, kind, from, payload, depends_on, priority }) {
    const r = resolveRepo(repo as string);
    return ask(r.stateDir, lane_id as string, { kind: kind as AskKind, from: from as string, payload, depends_on: depends_on as string[] | undefined, priority: priority as number | undefined });
  },
};

const askQueryClaimable: ToolDef = {
  name: "ask_query_claimable",
  description: "List every Ask in a Lane's queue that's unanswered, has all its dependencies met, and you're permitted to act on.",
  parameters: { type: "object", properties: { repo: { type: "string" }, lane_id: { type: "string" }, actor: { type: "string" } }, required: ["repo", "lane_id", "actor"] },
  async execute({ repo, lane_id, actor }) {
    const r = resolveRepo(repo as string);
    const lane = readLane(r.stateDir, lane_id as string);
    if (!lane) throw new Error(`no such lane: ${lane_id}`);
    return claimableAsks(lane, actor as string);
  },
};

const askClaim: ToolDef = {
  name: "ask_claim",
  description: "Claim an Ask: posts a claim_request and (self-)grants it. Returns the claimed Ask's full content so you can act on it.",
  parameters: { type: "object", properties: { repo: { type: "string" }, lane_id: { type: "string" }, ask_id: { type: "string" }, actor: { type: "string" } }, required: ["repo", "lane_id", "ask_id", "actor"] },
  async execute({ repo, lane_id, ask_id, actor }) {
    const r = resolveRepo(repo as string);
    const lane = readLane(r.stateDir, lane_id as string);
    const target = requireAsk(lane, ask_id as string);
    const grantedBy = lane!.coordinators[0] ?? actor;
    const claim = ask(r.stateDir, lane_id as string, { kind: "claim_request", from: actor as string, payload: { target: target.id } });
    answer(r.stateDir, lane_id as string, claim, { from: grantedBy, action: "grant", payload: { grant: `grant-${claim.id}` } });
    return target;
  },
};

const askAnswerTool: ToolDef = {
  name: "ask_answer",
  description: "Answer an Ask you've claimed: action \"complete\" with the result as payload when you've finished the work, or \"deny\" if you can't.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      ask_id: { type: "string" },
      actor: { type: "string" },
      action: { type: "string", enum: ["complete", "deny"] },
      payload: { type: "object" },
    },
    required: ["repo", "lane_id", "ask_id", "actor", "action"],
  },
  async execute({ repo, lane_id, ask_id, actor, action, payload }) {
    const r = resolveRepo(repo as string);
    const lane = readLane(r.stateDir, lane_id as string);
    const target = requireAsk(lane, ask_id as string);
    return answer(r.stateDir, lane_id as string, target, { from: actor as string, action: action as "complete" | "deny", payload });
  },
};

// --- real code: committing it, and testing it before committing -------

function validateChangesetFiles(files: unknown): string | null {
  if (!Array.isArray(files) || files.length === 0) return 'files must be a non-empty array of {path, content}. Example: [{"path": "index.js", "content": "..."}]';
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as Record<string, unknown>;
    if (!f || typeof f !== "object") return `files[${i}] must be an object {path, content}, got ${JSON.stringify(f)}`;
    if (typeof f.path !== "string" || !f.path) return `files[${i}] is missing a non-empty "path" string.`;
    if (typeof f.content !== "string") return `files[${i}] ("${f.path}") is missing a "content" string.`;
  }
  return null;
}

const commitChangesetTool: ToolDef = {
  name: "commit_changeset",
  description:
    "Commits file content as a git commit -- the only tool that writes code. No working-tree file is needed first: content lives entirely in this call (the same content you should have already posted in a submit_changeset ask). Call this once you're ready to commit, after posting that ask, mirroring how ladder_write_rung is only called once a merge_request has been posted.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      message: { type: "string" },
      author_name: { type: "string" },
      author_email: { type: "string" },
    },
    required: ["repo", "files", "message", "author_name", "author_email"],
  },
  async execute({ repo, files, message, author_name, author_email }) {
    const problem = validateChangesetFiles(files);
    if (problem) throw new Error(problem);
    const r = resolveRepo(repo as string);
    const commitOid = await commitChangeset(r.repoDir, {
      files: files as ChangesetFile[],
      message: message as string,
      author: { name: author_name as string, email: author_email as string },
    });
    return { commitOid };
  },
};

interface SandboxRepoSpec {
  repo: string;
  files?: ChangesetFile[];
}

const runInSandbox: ToolDef = {
  name: "run_in_sandbox",
  description:
    "Runs a command (e.g. a test suite) against one or more repos in a disposable, throwaway checkout -- never the real repo. Use this to verify your work BEFORE committing it, not after. Pass each repo you need (the one you're changing, plus any it depends on); give `files` only for the repo whose proposed-but-not-yet-committed content you want to test -- repos listed without `files` are checked out at their real current state, so a cross-repo dependency resolves the same way it would for real.",
  parameters: {
    type: "object",
    properties: {
      repos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            repo: { type: "string" },
            files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
          },
          required: ["repo"],
        },
      },
      command: { type: "string", description: "Shell command to run, e.g. \"node --test\"" },
      cwd: { type: "string", description: "Which repo (by slug) to run the command in" },
    },
    required: ["repos", "command", "cwd"],
  },
  async execute({ repos, command, cwd }) {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zz-sandbox-"));
    const worktrees: { repoDir: string; worktreePath: string; shortName: string }[] = [];
    try {
      for (const spec of repos as SandboxRepoSpec[]) {
        const r = resolveRepo(spec.repo);
        const worktreePath = join(sandboxRoot, r.name);
        execFileSync("git", ["-C", r.repoDir, "worktree", "add", "--detach", worktreePath, "HEAD"], { encoding: "utf8" });
        worktrees.push({ repoDir: r.repoDir, worktreePath, shortName: r.name });
        for (const f of spec.files ?? []) {
          const dest = join(worktreePath, f.path);
          mkdirSync(join(dest, ".."), { recursive: true });
          writeFileSync(dest, f.content);
        }
      }
      // Cross-repo dependencies resolve via a plain symlink (whether the
      // package.json says "file:../x" or a version range -- no real
      // registry exists for these packages either way) rather than
      // requiring `npm install` to succeed against something that isn't
      // actually published.
      const shortNames = new Set(worktrees.map((w) => w.shortName));
      for (const { worktreePath } of worktrees) {
        const pkgPath = join(worktreePath, "package.json");
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const depNames = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
        for (const dep of depNames) {
          if (!shortNames.has(dep)) continue;
          const other = worktrees.find((w) => w.shortName === dep)!;
          const nodeModules = join(worktreePath, "node_modules");
          mkdirSync(nodeModules, { recursive: true });
          const linkPath = join(nodeModules, dep);
          if (!existsSync(linkPath)) symlinkSync(other.worktreePath, linkPath);
        }
      }
      const cwdRepo = resolveRepo(cwd as string);
      const runDir = join(sandboxRoot, cwdRepo.name);
      try {
        const stdout = execFileSync("/bin/sh", ["-c", command as string], { cwd: runDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
      }
    } finally {
      for (const { repoDir, worktreePath } of worktrees) {
        try {
          execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath]);
        } catch {
          // best-effort cleanup
        }
      }
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  },
};

export const GIT_TOOLS: ToolDef[] = [gitLog, gitDiff, gitShowFile, ghFetchIssues, ghFetchPullRequests, ghFetchReleases, ghFetchContributors, ghFetchThreadComments];
export const LADDER_LANE_TOOLS: ToolDef[] = [ladderRead, ladderWriteRung, laneProposeTool, laneGet, askPostTool, askQueryClaimable, askClaim, askAnswerTool];
export const CODE_TOOLS: ToolDef[] = [commitChangesetTool, runInSandbox];
export const ALL_TOOLS: ToolDef[] = [...GIT_TOOLS, ...LADDER_LANE_TOOLS, ...CODE_TOOLS];

// The two tools that actually mutate committed state (a real commit, a
// real Ladder write) -- real RBAC enforcement for `zz work` isn't just
// the system prompt telling the model to behave; it's not handing these
// to the model at all unless the ask it's currently working is one
// where it's confirmed to be a coordinator (see ASK_SCOPE in
// engine/lane.ts and how cli/commands/work.ts picks a tool set per ask).
export const COORDINATOR_ONLY_TOOLS: ToolDef[] = [ladderWriteRung, commitChangesetTool];
export const CONTRIBUTOR_TOOLS: ToolDef[] = ALL_TOOLS.filter((t) => !COORDINATOR_ONLY_TOOLS.includes(t));
