// A code-driven alternative to the generic tool-calling loop
// (agent/loop.ts) for the two ask kinds where that loop has actually
// failed in practice: "work" (a contributor proposing a change) and
// "submit_changeset" (a coordinator committing one). Both failure
// modes traced back to the same root cause -- asking the model to
// assemble a large, nested JSON tool-call argument (a files array with
// multi-line content, or a Ladder rung tree) in one shot, then hoping
// it both gets the JSON right AND remembers the right sequence of
// calls to make. Real failures observed this way: malformed tool-call
// JSON (Groq rejecting it outright), and a model silently skipping the
// submit_changeset step and answering "complete" with files stuffed
// directly into the payload instead (caught structurally in
// engine/lane.ts, but better prevented than caught).
//
// The fix: the model is never handed a tool to call for these steps.
// It only ever produces plain text (file content in fenced code
// blocks, flat summary strings) -- the one thing every model, however
// small or cheap, is reliably good at. This code parses that text
// deterministically and drives every protocol step (claim, sandbox
// verification, submit, commit, Ladder writes, answer) itself, in a
// fixed order. The model supplies judgment (what the code should say,
// how to describe it); the code supplies sequencing and structure.
import { execFileSync } from "node:child_process";
import type { ChatBackend } from "./chatBackend.js";
import { ALL_TOOLS, checkNoDroppedExports } from "./tools.js";
import { resolveRepo, ensureCloned, type ResolvedRepo } from "../cli/lib/repo.js";
import { apiFetch } from "../cli/lib/api.js";
import type { AskEntry } from "../engine/types.js";
import { resolveBackend } from "../engine/backend.js";
import { fileContentAtCommit } from "../engine/ingest.js";
import { threeWayMerge } from "./threeWayMerge.js";

function findTool(name: string) {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
}

// Always local, unconditionally -- run_in_sandbox inherently needs a
// real local git worktree/node process, so it's never proxied to a
// remote repo regardless of mode (the state it reads/writes, Lane/
// Ladder/commits, lives remotely in that mode, but the sandbox run
// itself always happens on this machine).
async function localCallTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return findTool(name).execute(args);
}

// A plain-text completion: tools=[] tells every backend (see the
// "omit tools when empty" fix in each backend file) not to offer any
// tool-calling at all, so there's no tool-call JSON to get wrong --
// the model can only produce prose/code as its message content.
async function generateText(backend: ChatBackend, systemPrompt: string, userPrompt: string, onPartial?: (textSoFar: string) => void): Promise<string> {
  const message = await backend.chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    [],
    onPartial,
  );
  return message.content;
}

// Reads HEAD directly (`git ls-tree` + `git show`), never the working
// tree or index -- commit_changeset commits via git plumbing and never
// checks out a working copy (confirmed directly: the real on-disk
// files stay stale after every commit, and the index itself can be
// left in a half-updated state). Reading the working tree here was a
// real bug: it fed the model stale "current file" content on every
// call, which is the actual reason multiple concurrent proposals kept
// colliding on the same file in the first place, not a model
// limitation. Demo-repo sized, so dumping every file's full content is
// cheap; a larger repo would need this to be selective instead, which
// is a real limitation worth flagging if this pattern grows beyond the
// demo repos.
function currentRepoFiles(resolved: ResolvedRepo): { path: string; content: string }[] {
  const listing = execFileSync("git", ["-C", resolved.repoDir, "ls-tree", "-r", "HEAD", "--name-only"], { encoding: "utf8" });
  return listing
    .split("\n")
    .filter(Boolean)
    .map((path) => ({ path, content: fileContentAtCommit(resolved.repoDir, "HEAD", path) }));
}

// The commit a proposal was generated against -- recorded alongside
// it so that if HEAD has moved by the time it's actually committed,
// the real base for a 3-way merge is known rather than assumed.
function currentHeadSha(resolved: ResolvedRepo): string {
  return execFileSync("git", ["-C", resolved.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

interface ParsedFileProposal {
  summary: string;
  message: string;
  files: { path: string; content: string }[];
}

// Deterministic, not another model call: SUMMARY:/MESSAGE: header
// lines, then one "FILE: <path>" + fenced block per file. Tolerant of
// an optional language tag on the fence and of extra blank lines,
// since models vary slightly in exactly how they format this even
// though it's never asked to produce JSON.
function parseFileProposal(text: string): ParsedFileProposal {
  const summaryMatch = text.match(/^SUMMARY:\s*(.+)$/m);
  const messageMatch = text.match(/^MESSAGE:\s*(.+)$/m);
  const files: { path: string; content: string }[] = [];
  const fileRe = /^FILE:\s*(.+?)\s*\r?\n```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n```/gm;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) {
    files.push({ path: m[1].trim(), content: m[2] + "\n" });
  }
  if (files.length === 0) {
    throw new Error(`could not parse any "FILE: <path>" + fenced code block from the model's response -- got:\n${text.slice(0, 2000)}`);
  }
  return {
    summary: summaryMatch?.[1]?.trim() ?? "",
    message: messageMatch?.[1]?.trim() ?? files.map((f) => f.path).join(", "),
    files,
  };
}

// Checked before the sandbox, not just left to whatever tests happen
// to exist -- observed directly (gpt-oss-120b resolving a conflict):
// told explicitly to preserve everything in the current files, it
// still silently dropped an unrelated exported function from its
// "merged" index.js. A test suite only catches that if something
// happens to exercise the dropped export; this catches it either way,
// and fails fast (no sandbox worktree needed) with a precise reason
// the model can act on, the same check commit_changeset itself runs.
async function verifyProposal(resolved: ResolvedRepo, files: { path: string; content: string }[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const dropProblem = await checkNoDroppedExports(resolved.slug, files);
  if (dropProblem) return { exitCode: 1, stdout: "", stderr: dropProblem };
  return (await localCallTool("run_in_sandbox", {
    repos: [{ repo: resolved.slug, files }],
    command: "node --test",
    cwd: resolved.slug,
  })) as { exitCode: number; stdout: string; stderr: string };
}

// Posts the changeset_review first, then a submit_changeset that
// depends_on it -- submit_changeset literally cannot be claimed until
// a Maintainer grants the review (enforced in both agent/tools.ts's
// ask_claim and engine/lane.ts's answer()), so "mechanically merge
// it" and "is this actually what was asked for" are two separate,
// separately-gated steps, not one agent's unilateral judgment call.
async function postForReview(opts: {
  resolved: ResolvedRepo;
  laneId: string;
  agent: string;
  taskAskId: string;
  taskDescription: string;
  files: { path: string; content: string }[];
  message: string;
  summary: string;
  baseCommit: string;
  callTool: ProtocolCall;
  /** Shard provenance, when this proposal was actually committed for real in a task shard first (runContributorWorkAsk's remote path) -- carried for traceability/TUI display. Absent for local/demo mode and for runResolveConflict's own call (unchanged, no shard concept there). */
  source?: { repo: string; lane: string; commitOid: string };
}): Promise<void> {
  const { resolved, laneId, agent, taskAskId, taskDescription, files, message, summary, baseCommit, callTool, source } = opts;
  const review = (await callTool("ask_post", {
    repo: resolved.slug,
    lane_id: laneId,
    kind: "changeset_review",
    from: agent,
    payload: { taskDescription, files, message, summary, ...(source ? { source_repo: source.repo, source_lane: source.lane, commit_sha: source.commitOid } : {}) },
    depends_on: [],
  })) as AskEntry;
  await callTool("ask_post", {
    repo: resolved.slug,
    lane_id: laneId,
    kind: "submit_changeset",
    from: agent,
    payload: { files, message, summary, baseCommit, ...(source ? { source_repo: source.repo, source_lane: source.lane, commit_sha: source.commitOid } : {}) },
    depends_on: [taskAskId, review.id],
  });
}

const PROPOSE_SYSTEM_PROMPT = `You are an agent in the zz coordination system, acting as a contributor. You never call tools or write JSON here -- you only write plain text in the exact format below, and the surrounding system parses it and handles every protocol step (claiming, testing, submitting) itself.

Output format, exactly:
SUMMARY: <one sentence describing the whole change>
MESSAGE: <a short git commit message>
FILE: <path, relative to the repo root>
\`\`\`
<the file's FULL new content -- if you're changing an existing file, this must preserve everything it already did, not just the part you're adding>
\`\`\`
FILE: <another path, if you're touching more than one file>
\`\`\`
<its full content>
\`\`\`

List one FILE block per file you're adding or changing. Nothing else -- no prose outside these lines, no explanation, no tool calls.

If the prompt below lists "potentially relevant existing code elsewhere in the ecosystem", check whether it actually covers what you need before writing a new implementation yourself -- if it does, depend on it (add it to this file's dependencies/imports) and reference it, rather than reimplementing the same thing from scratch.`;

const FIX_SYSTEM_PROMPT = `${PROPOSE_SYSTEM_PROMPT}\n\nYour previous proposal failed when actually run. Fix it and output the same format again, for the full corrected set of files.`;

type ProtocolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ScriptedFlowOptions {
  resolved: ResolvedRepo;
  laneId: string;
  theAsk: AskEntry;
  agent: string;
  alreadyClaimed: boolean;
  backend: ChatBackend;
  onLog: (line: string) => void;
  /** Where a protocol mutation (ask_claim/ask_post/ask_answer/commit_changeset/ladder_write_rung) actually runs -- defaults to local execution. `zz work` against a remote repo passes callRemoteTool instead; run_in_sandbox is never affected by this, it's always local (see localCallTool/verifyProposal). */
  callTool?: ProtocolCall;
  /** Remote mode only, runContributorWorkAsk only: builds a real `git clone`-able URL (credentials embedded) for a given slug, the same way `zz work` clones the repos it started with -- needed here because a task shard (see worker/src/webApp.ts's ensureShard) is discovered mid-run, not known up front. Its presence is also what gates the whole shard flow: omitted (local/demo mode), the contributor keeps working directly on `resolved`, exactly as before this feature existed. */
  authedCloneUrlFor?: (slug: string) => string;
  /** Called once a task shard's local clone is ready, so the TUI/mainLoop start watching it immediately instead of only finding out once the ask that created it completes (see cli/lib/watchedRepos.ts). */
  onShardReady?: (repo: ResolvedRepo) => void;
  /** Live token-by-token text as a model call streams in, when the backend supports it (see ChatBackend.chat's own onPartial) -- `--assist` (tui/AssistApp.tsx) is the one caller that actually shows this; the autonomous path leaves it unset, same as before this existed. */
  onPartial?: (textSoFar: string) => void;
}

const MAX_SANDBOX_ATTEMPTS = 2;

/** The generate-then-sandbox-verify retry loop shared by a fresh proposal (proposeContributorWork) and a chat-revised one (reviseContributorWork) -- callers differ only in how they build the user prompt (fresh task framing vs. "here's the previous proposal plus feedback") and what system prompt a verified-from-scratch attempt starts with; a failed sandbox run always switches to FIX_SYSTEM_PROMPT on retry regardless of which caller is running. */
async function generateVerifiedProposal(opts: {
  resolved: ResolvedRepo;
  backend: ChatBackend;
  onLog: (line: string) => void;
  onPartial?: (textSoFar: string) => void;
  initialSystemPrompt: string;
  buildUserPrompt: (attempt: number, lastFailure: string) => string;
}): Promise<{ proposal: ParsedFileProposal; baseCommit: string } | { denialReason: string }> {
  const { resolved, backend, onLog, onPartial, initialSystemPrompt, buildUserPrompt } = opts;
  let systemPrompt = initialSystemPrompt;
  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_SANDBOX_ATTEMPTS; attempt++) {
    // baseCommit read fresh each attempt -- HEAD can genuinely move
    // between attempts (another agent's commit landing while this one
    // retries), so this is captured alongside each attempt's own
    // generation rather than once before the loop.
    const baseCommit = currentHeadSha(resolved);
    const userPrompt = buildUserPrompt(attempt, lastFailure);
    onLog(`[scripted] generating proposed files (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS})`);
    const text = await generateText(backend, systemPrompt, userPrompt, onPartial);
    const proposal = parseFileProposal(text);
    onLog(`[scripted] proposed ${proposal.files.map((f) => f.path).join(", ")} -- verifying`);
    const result = await verifyProposal(resolved, proposal.files);
    if (result.exitCode === 0) {
      onLog(`[scripted] sandbox passed`);
      return { proposal, baseCommit };
    }
    lastFailure = `exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    onLog(`[scripted] sandbox failed (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS}): ${lastFailure.slice(0, 300)}`);
    systemPrompt = FIX_SYSTEM_PROMPT;
  }
  return { denialReason: `sandbox verification failed after ${MAX_SANDBOX_ATTEMPTS} attempts: ${lastFailure.slice(0, 500)}` };
}

/** Everything proposeContributorWork resolved along the way that acceptContributorWork needs to finish the job -- resolved/laneId/shardSource differ from opts.resolved/opts.laneId exactly when sharding happened (see runContributorWorkAsk's own header comment on authedCloneUrlFor), so they're carried here rather than re-derived. */
export interface ContributorProposal {
  resolved: ResolvedRepo;
  laneId: string;
  shardSource?: { repo: string; lane: string; commitOid: string };
  proposal: ParsedFileProposal;
  baseCommit: string;
}

export type ContributorProposalResult = { ok: true; result: ContributorProposal } | { ok: false; denialReason: string };

/** The front half of what used to be one function: claim (if needed), shard setup, Ladder search for context, then generate+verify on retry -- stops the instant a proposal passes verification (or every attempt is exhausted) without writing anything or touching the protocol beyond the claim. `--assist` (cli/commands/work.ts) pauses here for a human to look at `result.proposal` before calling acceptContributorWork; the autonomous path (runContributorWorkAsk, below) just calls both back to back, unchanged behavior from before this split. */
export async function proposeContributorWork(opts: ScriptedFlowOptions): Promise<ContributorProposalResult> {
  const { resolved: parentResolved, laneId: parentLaneId, theAsk, agent, alreadyClaimed, backend, onLog, onPartial, callTool = localCallTool, authedCloneUrlFor, onShardReady } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: parentResolved.slug, lane_id: parentLaneId, ask_id: theAsk.id, actor: agent });
  }

  const description = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);

  // Remote contributor work always happens in a task shard: a real
  // forked repo scoped to this one task, owned by this agent (see
  // worker/src/webApp.ts's ensureShard) -- never directly on
  // parentResolved, which this agent doesn't own. `parentResolved`
  // here may itself already be a shard (a sub-agent picking up a
  // delegated piece of an already-sharded task), which is exactly what
  // makes sharding a shard work with no special-casing: ensureShard
  // only ever looks at whatever repo the ask's own Lane lives in.
  // Local/demo mode (authedCloneUrlFor omitted -- no Worker, no
  // Artifacts, no D1 to shard against) keeps working directly on
  // parentResolved, unchanged from before this feature existed.
  let resolved = parentResolved;
  let laneId = parentLaneId;
  let shardSource: { repo: string; lane: string; commitOid: string } | undefined;
  if (authedCloneUrlFor) {
    const shardRow = await apiFetch<{ slug: string }>("POST", `/api/repos/${parentResolved.slug}/shard`, { task: description });
    resolved = resolveRepo(shardRow.slug);
    ensureCloned(resolved, authedCloneUrlFor(shardRow.slug));
    onShardReady?.(resolved);
    onLog(`[scripted] working in shard ${shardRow.slug}`);

    const shardLane = (await callTool("lane_propose", {
      repo: shardRow.slug,
      name: description.slice(0, 60),
      objective: description,
      scope: ["**"],
      actor: agent,
      origin_lane: parentLaneId,
      origin_repo: parentResolved.slug,
    })) as { id: string };
    laneId = shardLane.id;
  }

  // Searched once, not re-run per sandbox attempt -- the task
  // description doesn't change between retries. This is the
  // code-driven equivalent of the generic loop's own ladder_search
  // tool call: generateText's empty tools array means the model can't
  // call a tool mid-generation in THIS flow at all (confirmed: an
  // empty tools array omits the "tools" field entirely from both the
  // Ollama and OpenAI-compatible request bodies), so "search before
  // writing new code" has to be driven by this surrounding code
  // instead of left to the model to decide. Without this, Ladder
  // content is written every time but never read back into a
  // decision anywhere -- "ecosystem-wide intelligence" that's
  // generated but never consulted. Goes through resolveBackend(), not
  // a direct API call -- works in both modes this way: remote mode
  // resolves to remoteBackend (a real cross-repo D1 search), local
  // mode to LocalBackend's own real search over whatever's cloned
  // under demo-repos/, not just remote.
  let relevantBlock = "";
  try {
    const hits = await resolveBackend().searchLadder(description, 5);
    if (hits.length) {
      relevantBlock = `\n\nPotentially relevant existing code elsewhere in the ecosystem -- consider depending on one of these instead of reimplementing it (add it to this repo's dependencies and import/reference it in your FILE output):\n${hits.map((h) => `- ${h.repo} ${h.path} (${h.kind}): ${h.summary}`).join("\n")}`;
    }
  } catch {
    // best-effort -- a search failure should never block the actual work
  }

  const gen = await generateVerifiedProposal({
    resolved,
    backend,
    onLog,
    onPartial,
    initialSystemPrompt: PROPOSE_SYSTEM_PROMPT,
    buildUserPrompt: (_attempt, lastFailure) => {
      // Re-read on every attempt, not just once before the loop -- HEAD
      // can genuinely move between attempts (another agent's commit
      // landing while this one retries), and reusing a stale snapshot
      // across retries was the same bug class as currentRepoFiles
      // reading the working tree: feeding the model outdated context
      // instead of giving it a real chance to account for what changed.
      const files = currentRepoFiles(resolved);
      const contextBlob = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
      const userPrompt = `Repo: ${resolved.slug}\nTask: ${description}\n\nCurrent files:\n${contextBlob}${relevantBlock}`;
      return lastFailure ? `${userPrompt}\n\nYour previous proposal's test run failed:\n${lastFailure}` : userPrompt;
    },
  });
  if ("denialReason" in gen) return { ok: false, denialReason: gen.denialReason };
  return { ok: true, result: { resolved, laneId, shardSource, proposal: gen.proposal, baseCommit: gen.baseCommit } };
}

/** A revised draft in response to a human's chat feedback on a previous proposal -- same generate-verify-retry mechanics as proposeContributorWork's own loop (via the same generateVerifiedProposal helper), just seeded with the previous proposal + the feedback instead of a blind first attempt. Nothing claimed/sharded here (that already happened); resolved/laneId/shardSource carry over from `current` unchanged, only proposal/baseCommit refresh. */
export async function reviseContributorWork(opts: ScriptedFlowOptions, current: ContributorProposal, feedback: string): Promise<ContributorProposalResult> {
  const { theAsk, backend, onLog, onPartial } = opts;
  const { resolved, laneId, proposal: previous } = current;
  const description = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);
  const previousBlob = previous.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");

  const gen = await generateVerifiedProposal({
    resolved,
    backend,
    onLog,
    onPartial,
    initialSystemPrompt: PROPOSE_SYSTEM_PROMPT,
    buildUserPrompt: (_attempt, lastFailure) => {
      const files = currentRepoFiles(resolved);
      const contextBlob = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
      const base = `Repo: ${resolved.slug}\nTask: ${description}\n\nCurrent files:\n${contextBlob}\n\nYour previous proposal:\n${previousBlob}\n\nFeedback from the human reviewing this proposal: ${feedback}\n\nProduce a revised proposal addressing the feedback, in the same FILE:/SUMMARY:/MESSAGE: format.`;
      return lastFailure ? `${base}\n\nYour previous revision's test run failed:\n${lastFailure}` : base;
    },
  });
  if ("denialReason" in gen) return { ok: false, denialReason: gen.denialReason };
  // shardSource deliberately not carried over -- it points at the
  // previous proposal's own commit, which no longer matches these
  // revised files. commitContributorWork/acceptContributorWork create
  // a fresh one for this revision when it's actually committed.
  return { ok: true, result: { resolved, laneId, proposal: gen.proposal, baseCommit: gen.baseCommit } };
}

/** The back half: commit for real in the shard (if sharded), write the Ladder, post the changeset_review/submit_changeset pair, and answer the original ask complete. Takes a (possibly human-edited, for --assist) proposal rather than generating one itself. */
/** Commits `proposed`'s current file content for real in the shard (remote mode only -- gated on authedCloneUrlFor exactly like this always was before this split; a no-op in local/demo mode, same as before) and writes the matching Ladder rungs, returning an updated ContributorProposal with a fresh shardSource. Safe to call more than once for the same ask -- each call is a new checkpoint commit, the same as committing periodically in any real coding session. `--assist`'s own `/commit` (cli/commands/workAssist.ts) calls this directly to persist progress to the shard without finalizing/submitting, so pausing (leaving the claim held) and coming back later never loses committed work; acceptContributorWork (below) calls it too, but skips a redundant empty commit when the proposal it's given already has a shardSource. */
export async function commitContributorWork(opts: ScriptedFlowOptions, proposed: ContributorProposal): Promise<ContributorProposal> {
  const { agent, onLog, callTool = localCallTool, authedCloneUrlFor } = opts;
  const { resolved, laneId, proposal } = proposed;
  if (!authedCloneUrlFor) return proposed;
  // Commit for real in the shard -- the agent owns it, so this is
  // authorized the same way a maintainer's own direct commit on a
  // repo it coordinates is (lane_propose made this agent the shard
  // lane's coordinator). This, plus the ladder write right after, is
  // the real "creating a changeset and a ladder within that lane" the
  // shard flow exists for -- not just a JSON payload like the
  // pre-shard design.
  onLog(`[scripted] committing ${proposal.files.map((f) => f.path).join(", ")} in ${resolved.slug}`);
  const commitResult = (await callTool("commit_changeset", {
    repo: resolved.slug,
    files: proposal.files,
    message: proposal.message,
    author_name: agent,
    author_email: `${agent}@local`,
  })) as { commitOid: string };
  const now = new Date().toISOString();
  const source = [{ kind: "commit" as const, ref: commitResult.commitOid, title: proposal.message, author: agent, at: now }];
  await callTool("ladder_write_rung", {
    repo: resolved.slug,
    rung: [
      ...proposal.files.map((f) => ({ path: f.path, kind: "file" as const, summary: proposal.summary, sources: source, children: [] })),
      {
        path: `changesets/${commitResult.commitOid}`,
        kind: "changeset" as const,
        summary: proposal.summary,
        sources: source,
        children: proposal.files.map((f) => ({ path: `changesets/${commitResult.commitOid}/${f.path}`, kind: "filechange" as const, summary: "changed.", sources: source, children: [] })),
      },
    ],
  });
  return { ...proposed, shardSource: { repo: resolved.slug, lane: laneId, commitOid: commitResult.commitOid } };
}

export async function acceptContributorWork(opts: ScriptedFlowOptions, proposed: ContributorProposal): Promise<void> {
  const { resolved: parentResolved, laneId: parentLaneId, theAsk, agent, onLog, callTool = localCallTool } = opts;
  const committed = proposed.shardSource ? proposed : await commitContributorWork(opts, proposed);
  const { proposal, baseCommit, shardSource } = committed;
  const description = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);

  await postForReview({
    resolved: parentResolved,
    laneId: parentLaneId,
    agent,
    taskAskId: theAsk.id,
    taskDescription: description,
    files: proposal.files,
    message: proposal.message,
    summary: proposal.summary,
    baseCommit,
    callTool,
    source: shardSource,
  });
  await callTool("ask_answer", {
    repo: parentResolved.slug,
    lane_id: parentLaneId,
    ask_id: theAsk.id,
    actor: agent,
    action: "complete",
    payload: { summary: proposal.summary },
  });
  onLog(`[scripted] posted for review and answered ${theAsk.id} complete`);
}

/** Just the final deny call -- split out so both the autonomous wrapper below and --assist's own "reject" path (cli/commands/work.ts) can use it without duplicating the payload shape. */
export async function denyContributorWork(opts: ScriptedFlowOptions, reason: string): Promise<void> {
  const { resolved, laneId, theAsk, agent, callTool = localCallTool, onLog } = opts;
  await callTool("ask_answer", {
    repo: resolved.slug,
    lane_id: laneId,
    ask_id: theAsk.id,
    actor: agent,
    action: "deny",
    payload: { reason },
  });
  onLog(`[scripted] denied ${theAsk.id}: ${reason.slice(0, 200)}`);
}

/** Gives up the claim on `theAsk` (either kind -- this is purely protocol-level, not specific to work vs. changeset_review) without answering it: it goes back to being claimable by anyone, including the same actor later. Any in-progress shard/draft is left exactly as it was (a shard's own commits are never undone by this -- see commitContributorWork), so this is the "I don't want to finish this right now, let someone else (or me later) pick it up" exit, distinct from denyContributorWork's terminal "this can't be done." */
export async function releaseAsk(opts: ScriptedFlowOptions): Promise<void> {
  const { resolved, laneId, theAsk, agent, callTool = localCallTool, onLog } = opts;
  await callTool("ask_release", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  onLog(`[scripted] released claim on ${theAsk.id} -- it's claimable again`);
}

export async function runContributorWorkAsk(opts: ScriptedFlowOptions): Promise<void> {
  const proposed = await proposeContributorWork(opts);
  if (!proposed.ok) {
    await denyContributorWork(opts, proposed.denialReason);
    return;
  }
  await acceptContributorWork(opts, proposed.result);
}

interface ChangesetPayload {
  files: { path: string; content: string }[];
  message: string;
  summary: string;
  baseCommit: string;
}

const SUMMARIZE_SYSTEM_PROMPT = `You describe code for a project's changelog. You never call tools or write JSON -- only plain text in the exact format below.

Output format, exactly, one block per file:
FILE: <path>
SUMMARY: <one or two sentences describing EVERYTHING this file does now, holistically -- not just what changed, the whole current purpose and behavior>

Then one final block:
CHANGESET: <one or two sentences describing this specific change>

Nothing else.`;

function parseSummaries(text: string): { perFile: Map<string, string>; changeset: string } {
  const perFile = new Map<string, string>();
  const fileRe = /^FILE:\s*(.+?)\r?\nSUMMARY:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) perFile.set(m[1].trim(), m[2].trim());
  const changesetMatch = text.match(/^CHANGESET:\s*(.+)$/m);
  return { perFile, changeset: changesetMatch?.[1]?.trim() ?? "" };
}

export async function runCoordinatorSubmitChangeset(opts: ScriptedFlowOptions): Promise<void> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, callTool = localCallTool } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as ChangesetPayload;

  // A real line-level 3-way merge first (git's own merge-file), not
  // symbol-name comparison -- most "conflicts" aren't conflicts at
  // all once you look at lines: a different file, or different lines
  // of the same file, merge cleanly with zero model involvement.
  // checkNoDroppedExports (inside commit_changeset) stays as a
  // last-resort safety net below, but shouldn't normally fire anymore.
  const merge = threeWayMerge(resolved.repoDir, payload.baseCommit, payload.files);
  if (!merge.clean) {
    const reason = `line-level conflict in: ${merge.conflicts.map((c) => c.path).join(", ")}`;
    await callTool("ask_answer", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent, action: "deny", payload: { reason } });
    // The original "work" ask's own description (not just the
    // rejected diff) -- lets the resolver treat this as a normal
    // additive task for whatever wasn't already resolved by the merge.
    const originLane = await resolveBackend().readLane(resolved.slug, laneId);
    const originAskId = theAsk.depends_on?.[0];
    const originAsk = originLane?.history.find((e): e is AskEntry => e.type === "ASK" && e.id === originAskId);
    const originalDescription = (originAsk?.payload as { description?: string } | undefined)?.description ?? payload.summary;
    await callTool("ask_post", {
      repo: resolved.slug,
      lane_id: laneId,
      kind: "resolve_conflict",
      from: agent,
      payload: { originalDescription, cleanFiles: merge.files, conflicts: merge.conflicts, message: payload.message, summary: payload.summary },
      depends_on: [],
    });
    onLog(`[scripted] ${reason} -- denied ${theAsk.id}, posted resolve_conflict`);
    return;
  }

  try {
    const files = merge.files; // the proposal's files, or the merged result if something landed in the meantime
    onLog(`[scripted] committing ${files.map((f) => f.path).join(", ")}`);
    const commitResult = (await callTool("commit_changeset", {
      repo: resolved.slug,
      files,
      message: payload.message,
      author_name: theAsk.from,
      author_email: `${theAsk.from}@local`,
    })) as { commitOid: string };
    const commitOid = commitResult.commitOid;

    const prompt = `Repo: ${resolved.slug}\nCommit: ${commitOid}\nCommit message: ${payload.message}\nChange summary (from the contributor): ${payload.summary}\n\nFiles:\n${files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")}`;
    const text = await generateText(backend, SUMMARIZE_SYSTEM_PROMPT, prompt);
    const { perFile, changeset } = parseSummaries(text);

    const now = new Date().toISOString();
    const source = [{ kind: "commit" as const, ref: commitOid, title: payload.message, author: theAsk.from, at: now }];
    const rungs = [
      ...files.map((f) => ({
        path: f.path,
        kind: "file" as const,
        summary: perFile.get(f.path) ?? payload.summary,
        sources: source,
        children: [],
      })),
      {
        path: `changesets/${commitOid}`,
        kind: "changeset" as const,
        summary: changeset || payload.summary,
        sources: source,
        children: files.map((f) => ({
          path: `changesets/${commitOid}/${f.path}`,
          kind: "filechange" as const,
          summary: perFile.get(f.path) ?? payload.summary,
          sources: source,
          children: [],
        })),
      },
    ];
    await callTool("ladder_write_rung", { repo: resolved.slug, rung: rungs });
    await callTool("ask_answer", {
      repo: resolved.slug,
      lane_id: laneId,
      ask_id: theAsk.id,
      actor: agent,
      action: "complete",
      payload: { commitOid },
    });
    onLog(`[scripted] committed ${commitOid} and wrote the Ladder -- answered ${theAsk.id} complete`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await callTool("ask_answer", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent, action: "deny", payload: { reason: message } });
    onLog(`[scripted] failed to commit/write the Ladder, denied ${theAsk.id}: ${message}`);
  }
}

interface ResolveConflictPayload {
  originalDescription: string;
  /** Files the 3-way merge already resolved cleanly -- unchanged, just need to ride along in the eventual commit. */
  cleanFiles: { path: string; content: string }[];
  /** Files with a genuine line-level overlap -- markedContent has git's own <<<<<<</=======/>>>>>>> (and ||||||| base, via --diff3) markers. */
  conflicts: { path: string; markedContent: string }[];
  message: string;
  summary: string;
}

// A narrow task -- resolve the few marked lines, not regenerate a
// whole file from two divergent versions (which proved unreliable
// even in the trivial additive case: a model asked to "reconcile" two
// full blobs dropped an unrelated export identically on every retry).
// threeWayMerge already did everything a real line-level merge can do
// automatically; a model only ever sees this for a genuine overlap,
// with git's own --diff3 markers showing base/ours/theirs inline.
const RESOLVE_MARKED_CONFLICT_SYSTEM_PROMPT = `You are an agent in the zz coordination system, acting as a contributor. One or more files have a real git merge conflict -- two changes touched the exact same lines. You never call tools or write JSON here -- you only write plain text in the exact format below.

Each conflicted file below has git's own conflict markers:
<<<<<<< ours        -- what's currently in the repo
||||||| base        -- what both sides started from
=======
>>>>>>> theirs      -- the other proposal

Resolve each conflict by combining both sides' intent where possible -- don't just pick one side and discard the other unless they're truly incompatible. Remove all markers from your output; output the file's complete resolved content.

Output format, exactly, one block per conflicted file:
FILE: <path, relative to the repo root>
\`\`\`
<the file's FULL resolved content, no conflict markers>
\`\`\`

Nothing else -- no prose outside these lines, no explanation, no tool calls.`;

export async function runResolveConflict(opts: ScriptedFlowOptions): Promise<void> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, callTool = localCallTool } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as ResolveConflictPayload;
  const conflictBlob = payload.conflicts.map((c) => `--- ${c.path} (has conflict markers) ---\n${c.markedContent}`).join("\n\n");
  const userPrompt = `Repo: ${resolved.slug}\nTask this change is part of: ${payload.originalDescription}\n\n${conflictBlob}`;

  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_SANDBOX_ATTEMPTS; attempt++) {
    const promptForAttempt = attempt === 1 ? userPrompt : `${userPrompt}\n\nYour previous resolution's test run failed:\n${lastFailure}`;
    onLog(`[scripted] resolving ${payload.conflicts.length} conflict(s) (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS})`);
    const text = await generateText(backend, RESOLVE_MARKED_CONFLICT_SYSTEM_PROMPT, promptForAttempt);
    const resolvedConflicts = parseFileProposal(text);
    const allFiles = [...payload.cleanFiles, ...resolvedConflicts.files];
    onLog(`[scripted] resolved ${resolvedConflicts.files.map((f) => f.path).join(", ")} -- verifying full set`);
    const result = await verifyProposal(resolved, allFiles);
    if (result.exitCode === 0) {
      const baseCommit = currentHeadSha(resolved);
      await postForReview({ resolved, laneId, agent, taskAskId: theAsk.id, taskDescription: payload.originalDescription, files: allFiles, message: payload.message, summary: payload.summary, baseCommit, callTool });
      await callTool("ask_answer", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent, action: "complete", payload: { summary: payload.summary } });
      onLog(`[scripted] conflict resolution passed -- posted for review and answered ${theAsk.id} complete`);
      return;
    }
    lastFailure = `exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    onLog(`[scripted] resolution failed (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS}): ${lastFailure.slice(0, 300)}`);
  }

  await callTool("ask_answer", {
    repo: resolved.slug,
    lane_id: laneId,
    ask_id: theAsk.id,
    actor: agent,
    action: "deny",
    payload: { reason: `conflict resolution failed verification after ${MAX_SANDBOX_ATTEMPTS} attempts: ${lastFailure.slice(0, 500)}` },
  });
  onLog(`[scripted] gave up resolving conflict after ${MAX_SANDBOX_ATTEMPTS} failed attempts -- denied ${theAsk.id}`);
}

interface ChangesetReviewPayload {
  taskDescription: string;
  files: { path: string; content: string }[];
  message: string;
  summary: string;
}

// The policy this judges against is site/content/governance/index.md's
// own definition of the Maintainer role -- "Reviews and decides;
// accountable for what merges" -- and its security principle "never
// trust self-declared scope": a Maintainer independently checks what a
// change actually touches against what it claims to, rather than
// trusting the contributor's own summary. This step exists
// specifically so that check is never skipped, not folded silently
// into the mechanical merge.
const CHANGESET_REVIEW_SYSTEM_PROMPT = `You are an agent in the zz coordination system, acting as a Maintainer (site/content/governance/index.md: "Reviews and decides; accountable for what merges"). You are reviewing a proposed changeset before it may be merged -- you are not testing it (that already happened) and not merging it (a separate, later step if you approve). Your only job: does this change actually match what was asked, does it stay in scope, does it do anything that wasn't requested. Never trust the contributor's own summary of what it did -- check the real file contents against the real task.

You never call tools or write JSON here -- you only write plain text in the exact format below.

Output format, exactly:
DECISION: approve
REASON: <one sentence>

or:

DECISION: request_changes
REASON: <what's wrong -- out of scope, does something unrequested, doesn't actually address the task, etc.>

Nothing else -- no prose outside these lines, no explanation, no tool calls.`;

function parseReviewDecision(text: string): { decision: "approve" | "request_changes"; reason: string } {
  const decisionMatch = text.match(/^DECISION:\s*(approve|request_changes)/m);
  const reasonMatch = text.match(/^REASON:\s*(.+)$/m);
  if (!decisionMatch) throw new Error(`could not parse a DECISION: approve|request_changes line from the model's response -- got:\n${text.slice(0, 1000)}`);
  return { decision: decisionMatch[1] as "approve" | "request_changes", reason: reasonMatch?.[1]?.trim() ?? "" };
}

export interface ReviewProposal {
  decision: "approve" | "request_changes";
  reason: string;
}

/** Claim (if needed) and draft a decision -- doesn't post anything. --assist (cli/commands/work.ts) shows `decision`/`reason` to a human, who may accept as-is or override either field, then calls acceptReview; runChangesetReview (below) just calls both back to back, unchanged behavior from before this split. */
export async function proposeReview(opts: ScriptedFlowOptions): Promise<ReviewProposal> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onPartial, callTool = localCallTool } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as ChangesetReviewPayload;
  const diffBlob = payload.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  const prompt = `Task that was asked for:\n${payload.taskDescription}\n\nProposed commit message: ${payload.message}\nContributor's own summary (verify this independently, don't just trust it): ${payload.summary}\n\nActual proposed file contents:\n${diffBlob}`;
  const text = await generateText(backend, CHANGESET_REVIEW_SYSTEM_PROMPT, prompt, onPartial);
  return parseReviewDecision(text);
}

const CHANGESET_DISCUSS_SYSTEM_PROMPT = `You are an agent in the zz coordination system, acting as a Maintainer discussing a proposed changeset with the human who will make the final approve/request_changes call. You already gave an initial recommendation; the human is now asking a follow-up question or pushing back on it. Answer plainly and specifically about the real file contents and the task -- don't repeat your whole earlier analysis, just address what they're asking. Free-form prose is fine here (this is discussion, not the final decision) -- no DECISION:/REASON: format, no tool calls.`;

/** Free-form Q&A about a changeset_review before the human finalizes it -- unlike proposeReview, this doesn't produce a DECISION:/REASON: pair, just an answer to append to the chat transcript. `conversation` is the prior turns (proposeReview's own initial recommendation counts as the first assistant turn) so follow-up questions have context. */
export async function discussReview(opts: ScriptedFlowOptions, conversation: { role: "assistant" | "user"; content: string }[], question: string): Promise<string> {
  const { theAsk, backend, onPartial } = opts;
  const payload = theAsk.payload as ChangesetReviewPayload;
  const diffBlob = payload.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  const history = conversation.map((t) => `${t.role === "assistant" ? "You" : "Human"}: ${t.content}`).join("\n\n");
  const prompt = `Task that was asked for:\n${payload.taskDescription}\n\nProposed commit message: ${payload.message}\nContributor's own summary: ${payload.summary}\n\nActual proposed file contents:\n${diffBlob}\n\nConversation so far:\n${history}\n\nHuman: ${question}`;
  return generateText(backend, CHANGESET_DISCUSS_SYSTEM_PROMPT, prompt, onPartial);
}

/** Posts the grant/deny this review's decision calls for -- a (possibly human-overridden) ReviewProposal, not necessarily the exact one proposeReview drafted. */
export async function acceptReview(opts: ScriptedFlowOptions, proposal: ReviewProposal): Promise<void> {
  const { resolved, laneId, theAsk, agent, onLog, callTool = localCallTool } = opts;
  if (proposal.decision === "approve") {
    await callTool("ask_answer", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent, action: "grant", payload: { reason: proposal.reason } });
    onLog(`[scripted] approved changeset_review ${theAsk.id}: ${proposal.reason}`);
    return;
  }

  await callTool("ask_answer", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent, action: "deny", payload: { reason: proposal.reason } });
  // The gated submit_changeset is now permanently unclaimable (its
  // depends_on will never resolve) -- a real, visible terminal state
  // in the lane log, not denied outright here: denying it is a
  // coordinator-scope action, and a Maintainer doing the reviewing is
  // deliberately not required to also be a coordinator (that's the
  // whole point of narrowing maintainers to e.g. a single human actor
  // who approves but never merges).
  onLog(`[scripted] requested changes on changeset_review ${theAsk.id}: ${proposal.reason} -- its submit_changeset stays permanently blocked`);
}

export async function runChangesetReview(opts: ScriptedFlowOptions): Promise<void> {
  const proposal = await proposeReview(opts);
  await acceptReview(opts, proposal);
}
