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

function validateTopLevelKind(rung: Rung): string | null {
  if (!VALID_TOP_LEVEL_KINDS.has(rung.kind)) {
    return `rung "${rung.path}" has kind "${rung.kind}", which can't be written as a top-level rung -- it has no git object of its own to anchor to. Nest it inside its parent's children array instead (e.g. a "filechange" goes inside a "changeset"'s children, not alongside it).`;
  }
  return null;
}

function validateAnchorSources(rung: Rung): string | null {
  if (RUNG_KINDS_NEEDING_A_COMMIT_SOURCE.has(rung.kind) && !rung.sources.some((s) => s.kind === "commit" && s.ref)) {
    return `rung "${rung.path}" (kind "${rung.kind}") has no commit source to anchor its note to. Add a sources entry: {kind: "commit", ref: "<the real commit sha this rung is about>", title, author, at}.`;
  }
  return null;
}

function validateHasSummary(rung: Rung): string | null {
  if (!rung.summary.trim()) return `rung "${rung.path}" has an empty summary. Every rung needs a real description -- if it shouldn't be there at all, leave it out of children entirely rather than including it with nothing to say.`;
  for (const child of rung.children) {
    const problem = validateHasSummary(child);
    if (problem) return problem;
  }
  return null;
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
      actor: { type: "string", description: "Your agent id -- becomes this Lane's coordinator" },
    },
    required: ["repo", "name", "objective", "scope", "actor"],
  },
  async execute({ repo, name, objective, scope, origin_lane, actor }) {
    const r = resolveRepo(repo as string);
    const origin: LaneRef | undefined = origin_lane ? { repo: r.slug, lane: origin_lane as string } : undefined;
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

export const GIT_TOOLS: ToolDef[] = [gitLog, gitDiff, gitShowFile, ghFetchIssues, ghFetchPullRequests, ghFetchReleases, ghFetchContributors, ghFetchThreadComments];
export const LADDER_LANE_TOOLS: ToolDef[] = [ladderRead, ladderWriteRung, laneProposeTool, laneGet, askPostTool, askQueryClaimable, askClaim, askAnswerTool];
export const ALL_TOOLS: ToolDef[] = [...GIT_TOOLS, ...LADDER_LANE_TOOLS];
