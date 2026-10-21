// The in-process tool catalog from site/content/mcp/index.md: zz-git and
// zz-ladder-lanes. Every tool is a thin wrapper over an existing engine
// function -- no new business logic here. Judgment (is a change
// material, how to decompose a task, when work is done) stays in the
// calling agent's own reasoning, never inside a tool.
import { randomBytes } from "node:crypto";
import { resolveRepo } from "../cli/lib/repo.js";
import { fetchContributors, fetchIssues, fetchPullRequests, fetchReleases, fetchThreadComments } from "../engine/ingest.js";
import { ask, answer, mergeLaneLadder, proposeLane, grantLaneRole, revokeLaneRole, addRelatedLane, tallyVotes, runIncidentRunbook, postInsight, attachConflictSubmission, applyConflictResolution, ORIGIN_LANE_ID } from "../engine/lane.js";
import { computeTrust } from "../engine/trust.js";
import { claimableAsks, claimHolder, isResolved } from "../engine/workqueue.js";
import { resolveBackend } from "../engine/backend.js";
import { resolveModelBackend } from "../engine/model.js";
import { type ChangesetFile } from "../engine/changeset.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rung } from "../engine/ladder.js";
import type { AnswerEntry, AskEntry, AskKind, Lane, LaneRef, RepoPolicy } from "../engine/types.js";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function requireAsk(lane: Lane | null, askId: string): AskEntry {
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
    const backend = resolveBackend();
    await backend.ensureCloned(repo as string);
    return backend.listCommits(repo as string);
  },
};

const gitDiff: ToolDef = {
  name: "git_diff",
  description: "What changed in one commit: which files, how (added/modified/deleted), and the diff hunks for modified files.",
  parameters: { type: "object", properties: { repo: { type: "string" }, sha: { type: "string" } }, required: ["repo", "sha"] },
  async execute({ repo, sha }) {
    const backend = resolveBackend();
    const commits = await backend.listCommits(repo as string);
    const commit = commits.find((c) => c.sha === sha);
    if (!commit) throw new Error(`no such commit: ${sha}`);
    return backend.diffCommit(repo as string, commit);
  },
};

const gitShowFile: ToolDef = {
  name: "git_show_file",
  description: "A file's full content as of a specific commit.",
  parameters: { type: "object", properties: { repo: { type: "string" }, sha: { type: "string" }, path: { type: "string" } }, required: ["repo", "sha", "path"] },
  async execute({ repo, sha, path }) {
    return resolveBackend().readFileAtCommit(repo as string, sha as string, path as string);
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
    return resolveBackend().readAnchor(repo as string, path as string);
  },
};

// The WHOLE resolved Ladder tree in one call -- the Ladder tab/zz
// top's own view. Deliberately separate from ladder_read (one rung by
// path): walking a tree one ladder_read per rung means one real
// round trip per rung for any caller outside the Worker itself (the
// CLI/TUI, dispatched through the generic remote tool-calling loop --
// confirmed live as the actual cause of `zz top`'s Ladder tab being
// unusably slow, and only getting worse on a repo with many files/
// changesets). readLadderTree lets each Backend implement its own
// best strategy for "give me everything at once" instead.
const ladderTree: ToolDef = {
  name: "ladder_tree",
  description: "Read the repo's full resolved Ladder tree in one call, not one ladder_read per rung -- use this instead of walking the tree yourself whenever you want the whole thing (e.g. to display it), not one specific rung.",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  async execute({ repo }) {
    return resolveBackend().readLadderTree(repo as string);
  },
};

// Cross-repo -- searches across every repo's Ladder at once, unlike
// every other tool here which is scoped to whatever `repo` arg it's
// given. Goes through resolveBackend() like everything else (NOT a
// direct apiFetch call to the search API -- that was tried first and
// is wrong: when this tool is dispatched through the generic remote
// tool-calling loop, its execute() runs server-side, inside the
// Durable Object, where there's no ~/.zz/credentials.json or
// filesystem to make an outbound authenticated HTTP call with.
// resolveBackend() is already correctly scoped to that DO's own
// backend via withBackend(), same as every other tool). Before
// proposing a new implementation of something, check whether it
// already exists somewhere in the ecosystem -- this is the
// "ecosystem-wide intelligence" the Ladder is for, made actually
// queryable instead of only ever written and never read back.
const ladderSearch: ToolDef = {
  name: "ladder_search",
  description:
    "Full-text search over every repo's Ladder (file/repo rung summaries -- what each file currently does, holistically) across the whole ecosystem, not just this repo. Use this before writing new code for something that might already exist elsewhere, so you can add a dependency and reference it instead of reimplementing it. Works in both remote mode (a real D1-backed cross-repo index) and --local/demo mode (a plain scan over whatever's cloned under demo-repos/).",
  parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  async execute({ query, limit }) {
    return resolveBackend().searchLadder(query as string, (limit as number) || 10);
  },
};

// Backfill for repos whose Ladder content predates the search index
// (or a repo's last reindex): ladder_search only ever sees what's
// been written since, so a file rung written before the feature
// existed stays invisible to search until something re-writes it or
// this runs. Scoped to THIS repo (unlike ladder_search, which is
// cross-repo) -- reindexing is a per-repo maintenance action, not a
// query.
const ladderReindex: ToolDef = {
  name: "ladder_reindex",
  description: "Backfill this repo's cross-repo search index from its current full Ladder tree -- use this once for a repo whose existing content (written before ladder_search existed, or since its last reindex) isn't turning up in ladder_search results. Returns how many rungs got (re)indexed. A no-op in --local/demo mode (nothing to backfill there -- it searches fresh every time).",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  async execute({ repo }) {
    const count = await resolveBackend().reindexLadder(repo as string);
    return { indexed: count };
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
const VALID_TOP_LEVEL_KINDS = new Set(["repo", "directory", "file", "release", "changeset", "ask", "contributor", "dependencies", "insight_norm", "insight_trap"]);

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
  // Trust the newest description over the old one, not a concatenation
  // of both -- confirmed live: this path is always Ollama specifically
  // (resolveModelBackend() with no provider override, regardless of
  // whatever provider the actual write came in with), so a caller
  // using any other provider hits this fallback on EVERY cumulative
  // write, not as a rare degraded case. Concatenating used to compound
  // without bound across repeated writes to the same rung (a bulk
  // import/sync re-pushing its whole already-correct local Ladder
  // every run, for instance) -- confirmed live, a real file's summary
  // after a handful of pushes was the same paragraph repeated three
  // times with minor rewording each round. incomingSummary is already
  // a complete, holistic description on its own (every real caller
  // generates one from the full current content, never a diff-only
  // fragment), so it's the correct fallback value, not a lesser one.
  if (!synthesized) return incomingSummary;
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
    const backend = resolveBackend();
    const rungs = (Array.isArray(rung) ? rung : [rung]).map(normalizeRung);
    for (const one of rungs) {
      const problem = validateTopLevelKind(one) ?? validateAnchorSources(one) ?? validateHasSummary(one);
      if (problem) throw new Error(problem);
    }
    for (const one of rungs) {
      if (!CUMULATIVE_SUMMARY_KINDS.has(one.kind)) continue;
      const existing = await backend.readAnchor(repo as string, one.path);
      if (existing?.summary && existing.summary !== one.summary) {
        one.summary = await foldInSummary(existing.summary, one.summary);
      }
    }
    await mergeLaneLadder(repo as string, rungs);
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
      id: { type: "string", description: 'Explicit lane id -- omit for a generated one. Used for well-known ids, e.g. "origin", the origin Lane every other Lane in a repo traces back to.' },
      committee: { type: "array", items: { type: "string" }, description: "Who must cast a ballot on a vote_request -- defaults to just you if omitted. Set this explicitly to actually seat a multi-member Committee. changeset_review no longer uses this; it's open-scope, any agent may submit one." },
      owners: {
        type: "array",
        items: { type: "string" },
        description:
          'Repo-level Owner tier (#41) -- meaningful only when this IS the origin Lane ("origin"); an ordinary work Lane has no repo-level authority of its own and should omit this. Defaults to empty, NOT to [actor] -- unlike coordinators, proposing a Lane does not make you its owner.',
      },
      viewers: { type: "array", items: { type: "string" }, description: "Repo-level explicit-read-access tier (#41) -- same origin-Lane-only caveat as owners. Grants read access to a private repo." },
    },
    required: ["repo", "name", "objective", "scope", "actor"],
  },
  async execute({ repo, name, objective, scope, origin_lane, origin_repo, actor, id, committee, owners, viewers }) {
    const origin: LaneRef | undefined = origin_lane ? { repo: (origin_repo as string) ?? (repo as string), lane: origin_lane as string } : undefined;
    return proposeLane(repo as string, {
      id: (id as string) ?? shortId("lane"),
      repo: repo as string,
      name: name as string,
      objective: objective as string,
      scope: scope as string[],
      proposedBy: actor as string,
      coordinators: [actor as string],
      committee: committee as string[] | undefined,
      owners: owners as string[] | undefined,
      viewers: viewers as string[] | undefined,
      origin,
    });
  },
};

const laneGrant: ToolDef = {
  name: "lane_grant",
  description:
    'Adds an agent to an EXISTING Lane\'s owners/coordinators/viewers/committee -- the only way to do this after the Lane was first proposed (lane_propose\'s own params only apply at creation). owner/coordinator/viewer are the repo-level Role hierarchy (#41), meaningful on the origin Lane ("origin"); committee is the unrelated voting axis any Lane can have. Granting "owner" requires already holding owner; granting anything else requires owner or coordinator.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      principal: { type: "string", description: "The agent id to add" },
      as: { type: "string", enum: ["owner", "coordinator", "viewer", "committee"] },
      actor: { type: "string", description: "Your agent id -- must already hold owner (to grant owner) or owner/coordinator (for anything else) on this Lane" },
    },
    required: ["repo", "lane_id", "principal", "as", "actor"],
  },
  async execute({ repo, lane_id, principal, as, actor }) {
    return grantLaneRole(repo as string, lane_id as string, { principal: principal as string, as: as as "owner" | "coordinator" | "viewer" | "committee", grantedBy: actor as string });
  },
};

const laneRevoke: ToolDef = {
  name: "lane_revoke",
  description:
    'The inverse of lane_grant: removes an agent from one of a Lane\'s owners/coordinators/viewers/committee lists. Same gating as lane_grant (owner-only to revoke owner, owner-or-coordinator for the rest), plus one extra refusal lane_grant doesn\'t need: revoking the LAST remaining owner is refused outright, since an origin Lane with zero owners would have no one left who could ever grant another one back.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      principal: { type: "string", description: "The agent id to remove" },
      as: { type: "string", enum: ["owner", "coordinator", "viewer", "committee"] },
      actor: { type: "string", description: "Your agent id -- must already hold owner (to revoke owner) or owner/coordinator (for anything else) on this Lane" },
    },
    required: ["repo", "lane_id", "principal", "as", "actor"],
  },
  async execute({ repo, lane_id, principal, as, actor }) {
    return revokeLaneRole(repo as string, lane_id as string, { principal: principal as string, as: as as "owner" | "coordinator" | "viewer" | "committee", revokedBy: actor as string });
  },
};

// The inverse of lane_propose's own origin_lane/origin_repo: that sets
// a CHILD lane's `.origin` pointer up to its parent; this records the
// same relationship on the PARENT's own `related_lanes`, so the parent
// side can enumerate its children without a reverse Ladder-wide scan.
// First real caller: runDecomposeWorkAsk (agent/scriptedWork.ts),
// splitting one task into several sibling Lanes.
const laneAddRelated: ToolDef = {
  name: "lane_add_related",
  description: "Record that another Lane relates to this one (e.g. a sub-Lane spawned by decomposing this Lane's own task) -- appends to this Lane's related_lanes.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "The repo of the Lane this relation is recorded ON" },
      lane_id: { type: "string", description: "The Lane this relation is recorded ON" },
      related_repo: { type: "string", description: "The repo the RELATED lane lives in" },
      related_lane: { type: "string", description: "The related Lane's id" },
      status: { type: "string", description: "The related Lane's current status, as of this recording" },
      // Same reason lane_propose takes its own separate origin_repo
      // rather than reusing `repo`: a remote tool call's `repo` field
      // gets rewritten server-side to the DO's own internal
      // artifacts_name before this ever runs (handleApiCallTool), so
      // reusing it here would silently store that internal name into
      // `origin.repo` instead of the real slug every other Lane field
      // uses. A separate field name is never touched by that rewrite.
      origin_repo: { type: "string", description: "The repo this Lane (the one named by `repo` above) actually lives in, for the stored origin pointer -- normally the same value you passed as `repo`" },
    },
    required: ["repo", "lane_id", "related_repo", "related_lane", "status", "origin_repo"],
  },
  async execute({ repo, lane_id, related_repo, related_lane, status, origin_repo }) {
    await addRelatedLane(repo as string, lane_id as string, {
      repo: related_repo as string,
      lane: related_lane as string,
      origin: { repo: origin_repo as string, lane: lane_id as string },
      status: status as Lane["status"],
    });
    return { ok: true };
  },
};

const laneGet: ToolDef = {
  name: "lane_get",
  description: "Read a Lane's full record: status, scope, coordinators, and its complete Ask/Answer history.",
  parameters: { type: "object", properties: { repo: { type: "string" }, lane_id: { type: "string" } }, required: ["repo", "lane_id"] },
  async execute({ repo, lane_id }) {
    return resolveBackend().readLane(repo as string, lane_id as string);
  },
};

// Exists so a remote Backend (cli/lib/remoteBackend.ts) can proxy
// Backend.listLanes() through the same tool-call surface (MaintainerDO.
// callTool only dispatches names in ALL_TOOLS) everything else uses,
// instead of needing its own bespoke endpoint. engine/workqueue.ts's
// claimableAcrossRepos is the real caller, via resolveBackend().
// listLanes(repo). Harmless to also leave model-facing -- read-only.
const laneList: ToolDef = {
  name: "lane_list",
  description: "List every Lane in a repo, full records.",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  async execute({ repo }) {
    return resolveBackend().listLanes(repo as string);
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
      deadline: { type: "string", description: 'ISO timestamp. On a "vote_request" with payload.lazyEligible true (a "vote_expiring" Policy rule), checkLazyConsensus ignores it (vote_tally handles that expiry instead) and ordinary asks use it for normal lazy consensus. On a "resolve_conflict" (a vote/escalate_human/mediate conflict_policy, #5), it opens a real window -- a further colliding submit_changeset attaches (conflict_attach) instead of spawning an independent one, until the deadline passes.' },
    },
    required: ["repo", "lane_id", "kind", "from"],
  },
  async execute({ repo, lane_id, kind, from, payload, depends_on, priority, deadline }) {
    return ask(repo as string, lane_id as string, { kind: kind as AskKind, from: from as string, payload, depends_on: depends_on as string[] | undefined, priority: priority as number | undefined, deadline: deadline as string | undefined });
  },
};

const askQueryClaimable: ToolDef = {
  name: "ask_query_claimable",
  description: "List every Ask in a Lane's queue that's unanswered, has all its dependencies met, and you're permitted to act on.",
  parameters: { type: "object", properties: { repo: { type: "string" }, lane_id: { type: "string" }, actor: { type: "string" } }, required: ["repo", "lane_id", "actor"] },
  async execute({ repo, lane_id, actor }) {
    const backend = resolveBackend();
    const lane = await backend.readLane(repo as string, lane_id as string);
    if (!lane) throw new Error(`no such lane: ${lane_id}`);
    // #32: repo Owners/Coordinators count toward committee-scope asks automatically.
    const originLane = lane_id !== ORIGIN_LANE_ID ? await backend.readLane(repo as string, ORIGIN_LANE_ID) : null;
    return claimableAsks(lane, actor as string, originLane);
  },
};

const askClaim: ToolDef = {
  name: "ask_claim",
  description: "Claim an Ask: posts a claim_request and (self-)grants it. Returns the claimed Ask's full content so you can act on it.",
  parameters: { type: "object", properties: { repo: { type: "string" }, lane_id: { type: "string" }, ask_id: { type: "string" }, actor: { type: "string" } }, required: ["repo", "lane_id", "ask_id", "actor"] },
  async execute({ repo, lane_id, ask_id, actor }) {
    const lane = await resolveBackend().readLane(repo as string, lane_id as string);
    const target = requireAsk(lane, ask_id as string);
    // An ask can never be un-answered (engine/lane.ts's answer() itself
    // rejects a second one outright) -- claimableAsks already excludes
    // an answered ask from what it reports as claimable, but that's
    // only a query-time filter; a direct ask_claim call (e.g. a TUI
    // list that intentionally shows the FULL history, answered asks
    // included, so there's somewhere to pick a done one for its own
    // history) bypassed that entirely, which let someone claim an
    // already-complete/denied ask and only discover the dead end much
    // later, at the final (impossible) re-answer step. Caught here,
    // right up front, with a clear "it's done, revise its feedback via
    // the review-deny flow's own posted follow-up instead" message.
    const existingAnswer = lane!.history.find((e): e is AnswerEntry => e.type === "ANSWER" && e.ask === target.id);
    if (existingAnswer) {
      throw new Error(
        `ask ${ask_id} was already answered (action "${existingAnswer.action}" at ${existingAnswer.at}) -- it can't be claimed again. If this was denied and needs rework, look for a new "work" ask carrying the feedback (acceptReview posts one automatically on a changeset_review deny) rather than reopening this one.`,
      );
    }
    // depends_on was previously only advisory (claimableAsks' query
    // filtered it out, but a direct ask_claim call bypassed that
    // entirely) -- the real enforcement a submit_changeset's required
    // changeset_review relies on.
    const unresolvedDeps = (target.depends_on ?? []).filter((depId) => !isResolved(lane!, depId, ["grant", "complete"]));
    if (unresolvedDeps.length > 0) {
      throw new Error(`ask ${ask_id} depends on ${unresolvedDeps.join(", ")}, which ${unresolvedDeps.length === 1 ? "isn't" : "aren't"} resolved yet -- that needs to be granted/completed first.`);
    }
    const grantedBy = lane!.coordinators[0] ?? actor;
    const claim = await ask(repo as string, lane_id as string, { kind: "claim_request", from: actor as string, payload: { target: target.id } });
    await answer(repo as string, lane_id as string, claim, { from: grantedBy, action: "grant", payload: { grant: `grant-${claim.id}` } });
    return target;
  },
};

const askRelease: ToolDef = {
  name: "ask_release",
  description: "Give up your own claim on an Ask without answering it -- it goes back to being claimable by anyone (including you again later), unlike ask_answer's \"deny\" (terminal) or just leaving it claimed forever.",
  parameters: { type: "object", properties: { repo: { type: "string" }, lane_id: { type: "string" }, ask_id: { type: "string" }, actor: { type: "string" } }, required: ["repo", "lane_id", "ask_id", "actor"] },
  async execute({ repo, lane_id, ask_id, actor }) {
    const lane = await resolveBackend().readLane(repo as string, lane_id as string);
    const target = requireAsk(lane, ask_id as string);
    const holder = claimHolder(lane!, target.id);
    if (holder !== actor) {
      throw new Error(`"${actor}" doesn't currently hold the claim on ask ${ask_id} (held by ${holder ?? "no one"}) -- only the current holder can release it.`);
    }
    const grantedBy = lane!.coordinators[0] ?? actor;
    const release = await ask(repo as string, lane_id as string, { kind: "claim_release", from: actor as string, payload: { target: target.id } });
    await answer(repo as string, lane_id as string, release, { from: grantedBy, action: "grant", payload: { release: `release-${release.id}` } });
    return target;
  },
};

const askAnswerTool: ToolDef = {
  name: "ask_answer",
  description:
    'Answer an Ask you\'ve claimed: action "complete" with the result as payload when you\'ve finished the work, "deny" if you can\'t, "veto" to reject a "changeset_review" over a design/priority disagreement (not just "doesn\'t meet the bar" -- use "deny" for that), or "vote" to cast one Committee ballot on a "vote_request" (payload { ballot: "+1"|"+0"|"-0"|"-1" }) -- unlike every other action, "vote" can be answered once per distinct actor on the same ask; call vote_tally afterward to count ballots and close it once every committee member has voted.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      ask_id: { type: "string" },
      actor: { type: "string" },
      action: { type: "string", enum: ["complete", "deny", "veto", "vote"] },
      payload: { type: "object" },
    },
    required: ["repo", "lane_id", "ask_id", "actor", "action"],
  },
  async execute({ repo, lane_id, ask_id, actor, action, payload }) {
    const lane = await resolveBackend().readLane(repo as string, lane_id as string);
    const target = requireAsk(lane, ask_id as string);
    return answer(repo as string, lane_id as string, target, { from: actor as string, action: action as AnswerEntry["action"], payload });
  },
};

const voteTally: ToolDef = {
  name: "vote_tally",
  description:
    'Counts ballots cast (ask_answer, action "vote") on a "vote_request" ask. Returns { resolved: false, missing: [...] } while any committee member hasn\'t voted yet -- nothing closes until then. Once everyone has, this posts the real "complete" that closes the vote and, if approved and the decision was a Policy change, actually applies it.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      ask_id: { type: "string" },
      actor: { type: "string" },
    },
    required: ["repo", "lane_id", "ask_id", "actor"],
  },
  async execute({ repo, lane_id, ask_id, actor }) {
    return tallyVotes(repo as string, lane_id as string, ask_id as string, actor as string);
  },
};

const conflictAttach: ToolDef = {
  name: "conflict_attach",
  description:
    '#5: attaches one more colliding submission onto an already-open "resolve_conflict" Ask (one with a deadline, posted for a vote/escalate_human/mediate conflict_policy -- first_wins/coordinator_decides resolve instantly and never have an open window to attach to) instead of spawning a second, independent resolve_conflict Ask or silently ignoring it. Refuses if the Ask is already answered or its deadline already passed -- find a fresh conflict path instead.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      resolve_conflict_ask_id: { type: "string" },
      files: { type: "array", items: { type: "object" } },
      message: { type: "string" },
      summary: { type: "string" },
      base_commit: { type: "string" },
      from: { type: "string" },
    },
    required: ["repo", "lane_id", "resolve_conflict_ask_id", "files", "message", "summary", "base_commit", "from"],
  },
  async execute({ repo, lane_id, resolve_conflict_ask_id, files, message, summary, base_commit, from }) {
    await attachConflictSubmission(repo as string, lane_id as string, resolve_conflict_ask_id as string, {
      files: files as { path: string; content: string }[],
      message: message as string,
      summary: summary as string,
      baseCommit: base_commit as string,
      from: from as string,
    });
    return { ok: true };
  },
};

const conflictResolve: ToolDef = {
  name: "conflict_resolve",
  description:
    '#7: applies a windowed "resolve_conflict" Ask\'s resolution for real -- commits the given files and completes the Ask, same commit+Ladder shape an ordinary changeset gets. Used by a human\'s escalate_human grant (`zz review`); a Committee Vote\'s own approval reaches the same underlying engine function directly through vote_tally instead of this tool.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      resolve_conflict_ask_id: { type: "string" },
      files: { type: "array", items: { type: "object" } },
      actor: { type: "string" },
      resolution_note: { type: "string" },
    },
    required: ["repo", "lane_id", "resolve_conflict_ask_id", "files", "actor", "resolution_note"],
  },
  async execute({ repo, lane_id, resolve_conflict_ask_id, files, actor, resolution_note }) {
    return applyConflictResolution(
      repo as string,
      lane_id as string,
      resolve_conflict_ask_id as string,
      files as { path: string; content: string }[],
      actor as string,
      resolution_note as string,
    );
  },
};

const whistleblowResolve: ToolDef = {
  name: "whistleblow_resolve",
  description:
    'Closes a "whistleblow" ask and runs the incident runbook (STOP this Lane, DROP the reported Agent\'s other pending Asks in it, and if target_commit names an already-merged commit, ROLL it back with a real revert commit) -- the direct action only this Lane\'s coordinator can take. Posts a trap-kind Insight recording what happened either way.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      ask_id: { type: "string" },
      actor: { type: "string" },
      target_agent: { type: "string" },
      target_commit: { type: "string" },
      reason: { type: "string" },
    },
    required: ["repo", "lane_id", "ask_id", "actor", "target_agent", "reason"],
  },
  async execute({ repo, lane_id, ask_id, actor, target_agent, target_commit, reason }) {
    const lane = await resolveBackend().readLane(repo as string, lane_id as string);
    const target = requireAsk(lane, ask_id as string);
    await answer(repo as string, lane_id as string, target, { from: actor as string, action: "complete", payload: { targetAgent: target_agent, targetCommit: target_commit, reason } });
    return runIncidentRunbook(repo as string, lane_id as string, { targetAgent: target_agent as string, targetCommit: target_commit as string | undefined, reason: reason as string }, actor as string);
  },
};

const insightPost: ToolDef = {
  name: "insight_post",
  description:
    'Posts an Insight -- a "norm" (something that worked, worth repeating) or a "trap" (a real mistake, worth not repeating) -- so a *different*, unrelated agent touching this repo later can actually find it via ladder_search, not just whoever happens to read this Lane\'s own history. Use this whenever you notice a real pattern during ordinary work: a review you deny for a reason likely to recur, a convention that turned out to matter, a dependency gotcha. Not for routine task outcomes -- post one when you\'d want a future agent, who never saw this Lane, to know it before making the same call.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      kind: { type: "string", enum: ["norm", "trap"] },
      text: { type: "string", description: "The insight itself, stated plainly enough to be useful out of context -- a future reader won't have this Lane's own history to fall back on." },
      actor: { type: "string" },
    },
    required: ["repo", "lane_id", "kind", "text", "actor"],
  },
  async execute({ repo, lane_id, kind, text, actor }) {
    return postInsight(repo as string, lane_id as string, { kind: kind as "norm" | "trap", text: text as string, from: actor as string });
  },
};

const trustGet: ToolDef = {
  name: "trust_get",
  description:
    "Computes an agent's Trust in a Lane -- a continuous, earned signal from its own recorded history (changesets merged vs. denied, reviews granted vs. vetoed, norm-kind Insights authored), not an assigned Role grant. Higher is more trusted; it can be negative; there's no fixed ceiling, and it's relative to other agents in the same Lane, not a normalized score. Read-only -- this doesn't gate anything yet, it's a signal to inform a judgment call, same as any other context you'd check before deciding.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      lane_id: { type: "string" },
      agent: { type: "string", description: "The agent to compute Trust for -- not necessarily the caller." },
    },
    required: ["repo", "lane_id", "agent"],
  },
  async execute({ repo, lane_id, agent }) {
    return computeTrust(repo as string, lane_id as string, agent as string);
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

// A regex-based export scan, not a real parser -- good enough to catch
// the actual failure mode observed: a model asked to add one function
// rewrites the WHOLE file from scratch instead of reading what's there
// first, silently dropping something that previously worked (one real
// case: a file re-exporting three functions got replaced by a file
// containing only the fourth, newly-added one -- no error, no trace,
// just gone). This can't tell a deliberate removal from an accidental
// one, so it blocks the write either way and makes the agent say so
// explicitly by re-adding it or by fixing the real content.
const EXPORT_NAME_RE = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)|export\s*\{([^}]+)\}/g;

function extractExportedNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const m of content.matchAll(EXPORT_NAME_RE)) {
    if (m[1]) names.add(m[1]);
    if (m[2]) {
      for (const part of m[2].split(",")) {
        const name = part.trim().split(/\s+as\s+/i)[0]?.trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

export async function checkNoDroppedExports(repo: string, files: ChangesetFile[]): Promise<string | null> {
  for (const f of files) {
    const before = await resolveBackend().readFileAtCommit(repo, "HEAD", f.path);
    if (!before.trim()) continue; // new file, nothing to preserve
    const beforeNames = extractExportedNames(before);
    const afterNames = extractExportedNames(f.content);
    const dropped = [...beforeNames].filter((n) => !afterNames.has(n));
    if (dropped.length > 0) {
      return `Your new content for "${f.path}" drops previously-exported name(s): ${dropped.join(", ")}. If that's genuinely intentional, that's fine -- but first double-check you actually read the file's current content (git_show_file) rather than rewriting it from scratch; the most common cause of this is composing a whole new file around just the one thing you're adding instead of preserving what was already there.`;
    }
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
    const dropProblem = await checkNoDroppedExports(repo as string, files as ChangesetFile[]);
    // A structural signal (matching the `resolved: true` pattern on the
    // duplicate-answer error below), not just phrasing -- lets a caller
    // (agent/scriptedWork.ts) tell "this is a real race with another
    // change that landed in the meantime" apart from any other failure,
    // without parsing the message text.
    if (dropProblem) throw Object.assign(new Error(dropProblem), { conflict: true });
    const commitOid = await resolveBackend().commitChangeset(repo as string, {
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
    // A model has been observed listing the same repo twice (the one
    // it's changing, plus -- misreading "pass any repo it depends on"
    // -- itself again as if it were its own dependency). Nothing
    // deduped that, so a second `git worktree add` at the identical
    // path crashed with a raw "fatal: already exists" instead of a
    // clear, self-correctable tool error. Dedupe by slug first,
    // keeping whichever entry has `files` (the one actually being
    // tested) over a plain current-state entry.
    const dedupedBySlug = new Map<string, SandboxRepoSpec>();
    for (const spec of repos as SandboxRepoSpec[]) {
      const existing = dedupedBySlug.get(spec.repo);
      if (!existing || (!existing.files && spec.files)) dedupedBySlug.set(spec.repo, spec);
    }
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zz-sandbox-"));
    const worktrees: { repoDir: string; worktreePath: string; shortName: string }[] = [];
    try {
      for (const spec of dedupedBySlug.values()) {
        const r = resolveRepo(spec.repo);
        const worktreePath = join(sandboxRoot, r.name);
        // stdio: fully suppressed, not just the default (which still
        // inherits stderr even with `encoding` set) -- git's own
        // "Preparing worktree (detached HEAD ...)" is progress noise on
        // stderr by git's own convention, and inheriting it leaks raw
        // text straight into the terminal, briefly corrupting a TUI's
        // alternate-screen frame (confirmed live: visible for a moment
        // in zz work/--assist, self-heals on ink's next re-render). The
        // return value isn't used here either way.
        execFileSync("git", ["-C", r.repoDir, "worktree", "add", "--detach", worktreePath, "HEAD"], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
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
          // Same reasoning as the `worktree add` above -- no stdio
          // override at all here was the actual default-inherits-stderr
          // case (even worse than `add`'s, which at least set
          // `encoding`), and `remove` prints its own progress line too.
          execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath], { stdio: ["ignore", "ignore", "ignore"] });
        } catch {
          // best-effort cleanup
        }
      }
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  },
};

const repoInfo: ToolDef = {
  name: "repo_info",
  description: "Reads a repo's owner and creation time. Anyone who can read the repo can call this -- same visibility as policy_show, just metadata instead of governance rules.",
  parameters: {
    type: "object",
    properties: { repo: { type: "string" } },
    required: ["repo"],
  },
  async execute({ repo }) {
    return resolveBackend().readRepoInfo(repo as string);
  },
};

const policyShow: ToolDef = {
  name: "policy_show",
  description: 'Reads a repo\'s current Policy document: `policy_change` (the rule for changing Policy itself), `policies` (path-glob rules for approving a clean change), and `conflict_policies` (path-glob rules for what happens when two changes collide, an orthogonal axis -- see #4). Anyone who can read the repo can call this -- Policy is meant to be visible, not just enforced.',
  parameters: {
    type: "object",
    properties: { repo: { type: "string" } },
    required: ["repo"],
  },
  async execute({ repo }) {
    return resolveBackend().readPolicy(repo as string);
  },
};

const policySet: ToolDef = {
  name: "policy_set",
  description:
    'Writes a direct change to Policy: `repo_rule` (replaces `policy_change`), `path_rule` (upserts one entry of `policies`, matched by its exact `path`), `claim_mode` (replaces it wholesale -- {manual, autonomous}, see #37), `retention_rule` (replaces it wholesale -- {mode, ttl_hours?}, see #39 -- "dispose" is real and destructive, deletes a completed work Lane\'s shard the moment its Lane goes terminal), or `conflict_path_rule` (upserts one entry of `conflict_policies`, matched by its exact `path` -- a second, orthogonal axis from `path_rule`: what happens when two changes collide, not what it takes to approve a clean one, see #4). This is the UNGATED path -- only an Owner may call it regardless of what `policy_change` currently says, or anyone else when `policy_change` itself is "direct" (enforced server-side, not here; see worker/src/webApp.ts\'s handleApiCallTool). Anyone else whose Policy is actually gated gets refused here and needs to go through the existing protocol instead: post an Ask (ask_post, kind "changeset_review" for self_review/other_approver, "vote_request" for vote_quorum/vote_expiring) with payload `{ decisionKind: "policy", proposal: {...} }` -- granting that review or tallying that vote applies the change for real, the same mechanism a Committee Vote on Policy already uses.',
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      actor: { type: "string" },
      repo_rule: { type: "object", properties: { mode: { type: "string" }, expiry_hours: { type: "number" } }, required: ["mode"] },
      path_rule: { type: "object", properties: { path: { type: "string" }, mode: { type: "string" }, expiry_hours: { type: "number" } }, required: ["path", "mode"] },
      claim_mode: { type: "object", properties: { manual: { type: "string" }, autonomous: { type: "string" } }, required: ["manual", "autonomous"] },
      retention_rule: { type: "object", properties: { mode: { type: "string" }, ttl_hours: { type: "number" } }, required: ["mode"] },
      conflict_path_rule: { type: "object", properties: { path: { type: "string" }, mode: { type: "string" } }, required: ["path", "mode"] },
    },
    required: ["repo", "actor"],
  },
  async execute({ repo, repo_rule, path_rule, claim_mode, retention_rule, conflict_path_rule }) {
    const backend = resolveBackend();
    const current = await backend.readPolicy(repo as string);
    if (repo_rule) {
      await backend.writePolicy(repo as string, { ...current, policy_change: repo_rule as RepoPolicy["policy_change"] });
    } else if (path_rule) {
      const rule = path_rule as RepoPolicy["policies"][number];
      const policies = [...current.policies.filter((r) => r.path !== rule.path), rule];
      await backend.writePolicy(repo as string, { ...current, policies });
    } else if (claim_mode) {
      await backend.writePolicy(repo as string, { ...current, claim_mode: claim_mode as RepoPolicy["claim_mode"] });
    } else if (retention_rule) {
      await backend.writePolicy(repo as string, { ...current, retention: retention_rule as RepoPolicy["retention"] });
    } else if (conflict_path_rule) {
      const rule = conflict_path_rule as RepoPolicy["conflict_policies"][number];
      const conflict_policies = [...current.conflict_policies.filter((r) => r.path !== rule.path), rule];
      await backend.writePolicy(repo as string, { ...current, conflict_policies });
    } else {
      throw new Error('policy_set needs one of "repo_rule", "path_rule", "claim_mode", "retention_rule", or "conflict_path_rule"');
    }
    return backend.readPolicy(repo as string);
  },
};

export const GIT_TOOLS: ToolDef[] = [gitLog, gitDiff, gitShowFile, ghFetchIssues, ghFetchPullRequests, ghFetchReleases, ghFetchContributors, ghFetchThreadComments];
export const LADDER_LANE_TOOLS: ToolDef[] = [ladderRead, ladderTree, ladderSearch, ladderReindex, ladderWriteRung, laneProposeTool, laneGrant, laneRevoke, laneAddRelated, laneGet, laneList, askPostTool, askQueryClaimable, askClaim, askRelease, askAnswerTool, voteTally, conflictAttach, conflictResolve, whistleblowResolve, insightPost, trustGet, policyShow, policySet, repoInfo];
export const CODE_TOOLS: ToolDef[] = [commitChangesetTool, runInSandbox];
export const ALL_TOOLS: ToolDef[] = [...GIT_TOOLS, ...LADDER_LANE_TOOLS, ...CODE_TOOLS];

// The tools that actually mutate committed state (a real commit, a
// real Ladder write, the incident runbook's own STOP/DROP/ROLL, a
// direct Policy write) -- real RBAC enforcement for `zz work` isn't
// just the system prompt telling the model to behave; it's not
// handing these to the model at all unless the ask it's currently
// working is one where it's confirmed to be a coordinator (see
// ASK_SCOPE in engine/lane.ts and how cli/commands/work.ts picks a
// tool set per ask). policy_set additionally gets its own, stricter
// server-side gate (Owner-or-"policy_change is direct" only) -- being handed
// the tool at all is necessary but not sufficient for it to succeed.
export const COORDINATOR_ONLY_TOOLS: ToolDef[] = [ladderWriteRung, commitChangesetTool, whistleblowResolve, policySet];
export const CONTRIBUTOR_TOOLS: ToolDef[] = ALL_TOOLS.filter((t) => !COORDINATOR_ONLY_TOOLS.includes(t));
