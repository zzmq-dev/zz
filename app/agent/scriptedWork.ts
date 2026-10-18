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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatBackend } from "./chatBackend.js";
import { ALL_TOOLS, checkNoDroppedExports } from "./tools.js";
import { resolveRepo, ensureCloned, ensureNamedWorktree, type ResolvedRepo } from "../cli/lib/repo.js";
import { apiFetch } from "../cli/lib/api.js";
import type { AskEntry, RepoPolicy } from "../engine/types.js";
import { resolveBackend } from "../engine/backend.js";
import { resolvePolicyMode } from "../engine/policy.js";
import { fileContentAtCommit } from "../engine/ingest.js";
import { threeWayMerge } from "./threeWayMerge.js";
import { diffFileSets } from "../cli/lib/fileDiff.js";

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
// Model calls hit a real network every time, regardless of backend
// (OpenAI/Anthropic/Ollama/whatever -- see engine/model.ts) -- a
// transient failure there (a connect timeout, a dropped connection, a
// momentary 5xx) is routine, not a sign anything is actually wrong,
// the same way a flaky HTTP call anywhere else gets retried rather
// than treated as fatal on the first attempt. Confirmed live: an
// uncaught "fetch failed / Connect Timeout Error" here propagated
// all the way up through workClaimed and killed a whole --stdio run,
// the same shape of problem as the already-answered signal fixed
// just before this -- one transient, single-ask failure taking down
// an entire unattended run instead of being retried or at least
// logged and moved past.
const MAX_GENERATE_ATTEMPTS = 3;

async function generateText(backend: ChatBackend, systemPrompt: string, userPrompt: string, onLog: (line: string) => void, onPartial?: (textSoFar: string) => void): Promise<string> {
  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ];
  for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt++) {
    try {
      const message = await backend.chat(messages, [], onPartial);
      return message.content;
    } catch (err) {
      if (attempt === MAX_GENERATE_ATTEMPTS) throw err;
      const delayMs = 1000 * 2 ** (attempt - 1); // 1s, then 2s
      onLog(`[scripted] model call failed (attempt ${attempt}/${MAX_GENERATE_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)} -- retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable"); // the loop above always either returns or throws on its last attempt
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

// Posts whatever Policy actually requires for the touched files, then
// a submit_changeset that depends_on it -- submit_changeset literally
// cannot be claimed until that dependency grants/resolves (enforced in
// both agent/tools.ts's ask_claim and engine/lane.ts's answer()'s own
// merge backstop), so "mechanically merge it" and "is this actually
// allowed" are two separate, separately-gated steps, not one agent's
// unilateral judgment call. A repo with no policies set behaves
// exactly as before this existed (resolvePolicyMode's own default):
// self_review, i.e. always a changeset_review, any maintainer may
// grant their own.
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
  const sourceFields = source ? { source_repo: source.repo, source_lane: source.lane, commit_sha: source.commitOid } : {};
  const policy = (await callTool("policy_show", { repo: resolved.slug })) as RepoPolicy;
  const rule = resolvePolicyMode(policy, files.map((f) => f.path));

  const dependsOn = [taskAskId];
  if (rule.mode === "vote_quorum" || rule.mode === "vote_expiring") {
    const lazyEligible = rule.mode === "vote_expiring";
    const vote = (await callTool("ask_post", {
      repo: resolved.slug,
      lane_id: laneId,
      kind: "vote_request",
      from: agent,
      payload: { decisionKind: "other", taskDescription, files, message, summary, baseCommit, lazyEligible, ...sourceFields },
      depends_on: [],
      ...(lazyEligible ? { deadline: new Date(Date.now() + (rule.expiry_hours ?? 72) * 3_600_000).toISOString() } : {}),
    })) as AskEntry;
    dependsOn.push(vote.id);
  } else if (rule.mode !== "direct") {
    // self_review or other_approver -- both need a changeset_review;
    // other_approver's own extra bar (approver != author) is checked
    // at completion time (engine/lane.ts's merge backstop), not here.
    const review = (await callTool("ask_post", {
      repo: resolved.slug,
      lane_id: laneId,
      kind: "changeset_review",
      from: agent,
      payload: { taskDescription, files, message, summary, baseCommit, ...sourceFields },
      depends_on: [],
    })) as AskEntry;
    dependsOn.push(review.id);
  }

  await callTool("ask_post", {
    repo: resolved.slug,
    lane_id: laneId,
    kind: "submit_changeset",
    from: agent,
    payload: { files, message, summary, baseCommit, ...sourceFields },
    depends_on: dependsOn,
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

When adding a brand-new function (not editing an existing one), give it its own new file under \`src/\` (e.g. \`src/isPrime.js\`, exporting just that function and its own tests alongside), and wire it into the project's main entry file with a single added re-export line (e.g. \`export { isPrime } from "./src/isPrime.js";\`) -- never restate that entry file's other existing exports or function bodies just to add one more. Several of these can run at once on the same repo: keeping each new function in its own file is what keeps them from colliding when they land, and keeps every file small enough for a reviewer to check quickly.

If the prompt below lists "potentially relevant existing code elsewhere in the ecosystem", check whether it actually covers what you need before writing a new implementation yourself -- if it does, depend on it (add it to this file's dependencies/imports) and reference it, rather than reimplementing the same thing from scratch.

Your code is verified by actually running it in a disposable sandbox, with no network access and no package install step -- only what's already in the repo (plus Node's own built-ins) is available, so two things matter for anything you write to actually pass:
- Tests run with Node's own built-in test runner ("node --test"). Import \`test\`/\`describe\` from "node:test" and assertions from "node:assert" (or "node:assert/strict") -- never assume a third-party framework like Jest, Mocha, or Vitest is installed, because nothing installs it. A bare \`describe(...)\`/\`test(...)\` with no import, or an \`import ... from "vitest"\`, will fail with "not defined"/"module not found," not pass.
- A plain JavaScript file runs as real Node ESM: use \`export function\`/\`export const\` and \`import\`, never CommonJS's \`module.exports\`/\`require\` (mixing the two across your implementation and test file is exactly the "named export not found" error you'd see if you did) -- and the file extension is required on every relative import (e.g. \`import { foo } from "./foo.js"\`, never \`"./foo"\`); TypeScript's own extensionless resolution doesn't apply here.`;

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

/** Writes a verified draft straight into the real working tree on disk (`resolved.repoDir`) -- a plain file write, never a git operation. Lets a human `cd` into the shard mid-session (another terminal, an editor, running the code) and see exactly what's being proposed without waiting for /commit, since commit_changeset's own git plumbing (engine/backend.ts's remoteBackend) never touches a local checkout at all -- it commits server-side, directly into Artifacts' object store. Deliberately decoupled from currentRepoFiles/currentHeadSha, which always read committed state via git plumbing (`git show HEAD:...`), never the working tree -- so these files sitting here ahead of any commit can never leak into what a later regeneration treats as "current state." */
function writeFilesToWorkingTree(resolved: ResolvedRepo, files: { path: string; content: string }[]): void {
  for (const f of files) {
    const dest = join(resolved.repoDir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }
}

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
    const text = await generateText(backend, systemPrompt, userPrompt, onLog, onPartial);
    const proposal = parseFileProposal(text);
    onLog(`[scripted] proposed ${proposal.files.map((f) => f.path).join(", ")} -- verifying`);
    const result = await verifyProposal(resolved, proposal.files);
    if (result.exitCode === 0) {
      onLog(`[scripted] sandbox passed`);
      writeFilesToWorkingTree(resolved, proposal.files);
      onLog(`[scripted] wrote the draft to ${resolved.repoDir}`);
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

  // priorAttempt is a separate field, not folded into description
  // itself -- description feeds the shard's own task-name/objective and
  // the Ladder search query below, both of which want the short task
  // text, not a whole rejected file dump riding along; the UI's own
  // describeAsk (tui/AssistApp.tsx) reads description too, for the same
  // reason (a one-line picker/header summary, not a wall of code).
  const payload = theAsk.payload as { description?: string; priorAttempt?: { reason: string; files: { path: string; content: string }[] } } | undefined;
  const description = payload?.description ?? JSON.stringify(theAsk.payload);
  const priorAttemptBlock = payload?.priorAttempt
    ? `\n\nA Maintainer requested changes on a previous submission for this task: ${payload.priorAttempt.reason}\n\nThe previous (rejected) draft, for reference -- revise it to address the feedback rather than starting over from scratch:\n${payload.priorAttempt.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")}`
    : "";

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
      const userPrompt = `Repo: ${resolved.slug}\nTask: ${description}\n\nCurrent files:\n${contextBlob}${relevantBlock}${priorAttemptBlock}`;
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

interface ParsedSubtask {
  name: string;
  description: string;
}

// Same regex shape as parseFileProposal's own FILE: + fenced block --
// a fence is a reliable boundary for "where does this block end" even
// though what's inside is prose, not code, and it keeps this parser
// consistent with the rest of the file's "the model only ever produces
// plain text in one fixed format" approach.
function parseSubtasks(text: string): ParsedSubtask[] {
  const subtasks: ParsedSubtask[] = [];
  const re = /^SUBTASK:\s*(.+?)\s*\r?\n```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n```/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    subtasks.push({ name: m[1].trim(), description: m[2].trim() });
  }
  if (subtasks.length === 0) {
    throw new Error(`could not parse any "SUBTASK: <name>" + fenced description block from the model's response -- got:\n${text.slice(0, 2000)}`);
  }
  return subtasks;
}

const DECOMPOSE_SYSTEM_PROMPT = `You are an agent in the zz coordination system, splitting one task into several independent sub-tasks. Each sub-task you describe will be posted as its own new Ask into its own new Lane, for a contributor (another agent, or a human) to pick up and finish independently of the others. You never call tools or write JSON here -- you only write plain text in the exact format below.

Split the task into genuinely independent pieces -- each small enough for a single contributor to finish in one pass, and not depending on any other piece finishing first. If a piece truly can't start until another one finishes, that's a sign the split is wrong, not something to represent here -- this format has no way to express a dependency between sub-tasks.

Output format, exactly, one block per sub-task:
SUBTASK: <a short name, a few words -- used to label the new Lane>
\`\`\`
<the full task description for whoever picks this up -- specific enough to act on without needing to see the original task>
\`\`\`

List at least 2 sub-tasks. Nothing else -- no prose outside these lines, no explanation, no tool calls.`;

/** Splits one "work" Ask (payload.description) into several independent sub-tasks, each posted as a fresh "work" Ask into its own new sibling Lane (lane_propose with this Ask's own Lane as origin) -- then records each one on this Lane's own related_lanes (lane_add_related), the first real populator of that field, so the parent side can enumerate what it spawned. Answers the original Ask complete once every sub-task is posted; never generates or commits any code itself. Triggered when payload.decompose is true (set by `zz repo ask --decompose`) instead of the plain runContributorWorkAsk a "work" Ask normally gets -- see cli/commands/work.ts's own dispatch. */
export async function runDecomposeWorkAsk(opts: ScriptedFlowOptions): Promise<void> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, onPartial, callTool = localCallTool } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as { description?: string } | undefined;
  const description = payload?.description ?? JSON.stringify(theAsk.payload);

  onLog(`[scripted] decomposing: ${description.slice(0, 120)}`);
  const text = await generateText(backend, DECOMPOSE_SYSTEM_PROMPT, `Task to split into independent sub-tasks:\n${description}`, onLog, onPartial);
  const subtasks = parseSubtasks(text);
  onLog(`[scripted] split into ${subtasks.length} sub-task(s): ${subtasks.map((s) => s.name).join(", ")}`);

  const childLaneIds: string[] = [];
  for (const sub of subtasks) {
    const childLane = (await callTool("lane_propose", {
      repo: resolved.slug,
      name: sub.name,
      objective: sub.description,
      scope: ["**"],
      actor: agent,
      origin_lane: laneId,
      origin_repo: resolved.slug,
    })) as { id: string; status: string };
    await callTool("ask_post", {
      repo: resolved.slug,
      lane_id: childLane.id,
      kind: "work",
      from: agent,
      payload: { description: sub.description },
      depends_on: [],
    });
    await callTool("lane_add_related", {
      repo: resolved.slug,
      lane_id: laneId,
      related_repo: resolved.slug,
      related_lane: childLane.id,
      status: childLane.status,
      origin_repo: resolved.slug,
    });
    childLaneIds.push(childLane.id);
    onLog(`[scripted] posted "${sub.name}" into new lane ${childLane.id}`);
  }

  await callTool("ask_answer", {
    repo: resolved.slug,
    lane_id: laneId,
    ask_id: theAsk.id,
    actor: agent,
    action: "complete",
    payload: { decomposedInto: childLaneIds },
  });
  onLog(`[scripted] decomposition complete -- answered ${theAsk.id} complete, ${childLaneIds.length} sub-lane(s) created`);
}

const SHOULD_DECOMPOSE_SYSTEM_PROMPT = `You are an agent in the zz coordination system, deciding how to approach one task before starting it. You never call tools or write JSON here -- you only write plain text in the exact format below.

Decide: is this task small enough to implement directly in a single focused pass, or does it actually bundle several genuinely independent pieces of work that would be better split into separate sub-tasks, each tracked and claimable on its own?

Default to NOT decomposing -- most tasks are small enough to just do directly. Only decompose when the task explicitly describes multiple distinct, independent deliverables (e.g. "add functions A, B, and C, each in their own file") where splitting them would let different contributors work on them in parallel. A single focused change, even a moderately large one, is still "direct."

Output format, exactly:
DECISION: decompose
or
DECISION: direct

Nothing else -- no prose, no explanation, no tool calls.`;

function parseShouldDecompose(text: string): boolean {
  const m = text.match(/^DECISION:\s*(decompose|direct)/m);
  if (!m) throw new Error(`could not parse a DECISION: decompose|direct line from the model's response -- got:\n${text.slice(0, 500)}`);
  return m[1] === "decompose";
}

/** What cli/commands/work.ts's autonomous loop actually calls for every "work" Ask now, instead of runContributorWorkAsk directly -- lets the agent itself judge, per Ask, whether to split it (runDecomposeWorkAsk) or just implement it directly (runContributorWorkAsk), via one cheap classification call before either path claims anything (only whichever path actually runs does the real claim, so there's no double-claim). payload.decompose (set by `zz repo ask --decompose`) skips the question and forces decomposition outright -- a human's explicit call always wins over the model's own judgment. */
export async function runWorkAsk(opts: ScriptedFlowOptions): Promise<void> {
  const { theAsk, backend, onLog, onPartial } = opts;
  const payload = theAsk.payload as { description?: string; decompose?: boolean } | undefined;
  if (payload?.decompose) {
    await runDecomposeWorkAsk(opts);
    return;
  }
  const description = payload?.description ?? JSON.stringify(theAsk.payload);
  const text = await generateText(backend, SHOULD_DECOMPOSE_SYSTEM_PROMPT, `Task:\n${description}`, onLog, onPartial);
  const decompose = parseShouldDecompose(text);
  onLog(`[scripted] ${decompose ? "decided to decompose this task into sub-tasks" : "decided this task is small enough to implement directly"}`);
  await (decompose ? runDecomposeWorkAsk(opts) : runContributorWorkAsk(opts));
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
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, callTool = localCallTool, authedCloneUrlFor } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as ChangesetPayload & { source_repo?: string };

  // baseCommit was read as the task SHARD's own HEAD (postForReview's
  // caller), not the origin's -- when this changeset came from a
  // shard, that commit only exists in the shard's own git history.
  // threeWayMerge below diffs it against resolved.repoDir (the
  // ORIGIN's local clone), which never has those objects unless
  // fetched first. Confirmed live: a self-merge (Stage 3, maintainer
  // reviewing/merging its own sharded work) failed here with git's own
  // "fatal: bad object" on exactly the second changeset in a row --
  // the first one's objects happened to already be reachable from a
  // prior fetch, the second one's weren't.
  if (payload.source_repo && authedCloneUrlFor) {
    execFileSync("git", ["-C", resolved.repoDir, "fetch", "--quiet", authedCloneUrlFor(payload.source_repo), "main"], { stdio: "inherit" });
  }

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
    const text = await generateText(backend, SUMMARIZE_SYSTEM_PROMPT, prompt, onLog);
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
    const text = await generateText(backend, RESOLVE_MARKED_CONFLICT_SYSTEM_PROMPT, promptForAttempt, onLog);
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
  /** Absent on an older ask posted before this field existed -- prepareReviewWorkspace falls back to a plain file dump (no base to diff against) in that case. */
  baseCommit?: string;
  /** Shard provenance (postForReview's own `source` param) -- when present, prepareReviewWorkspace clones/syncs *that* repo (the one the contributor actually worked in) instead of writing into the review ask's own parent repo. */
  source_repo?: string;
  source_lane?: string;
  commit_sha?: string;
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

export interface ReviewWorkspace {
  repoDir: string;
  diff: string;
}

/**
 * Resolves which repo a changeset_review's files actually belong to -- the
 * task shard the contributor worked in, when the ask names one
 * (source_repo) and a clone-URL function is available (remote mode),
 * falling back to the review's own parent repo otherwise. Ensures it's
 * cloned (or just fetched, if already present -- see ensureCloned's own
 * comment; never resets its working tree) before returning. Shared by
 * prepareReviewWorkspace and proposeReview below, which previously each
 * re-derived this independently -- one real path for "which repo is this
 * review actually about," not two.
 */
function resolveReviewTarget(resolved: ResolvedRepo, payload: ChangesetReviewPayload, authedCloneUrlFor?: (slug: string) => string): ResolvedRepo {
  if (payload.source_repo && authedCloneUrlFor) {
    const target = resolveRepo(payload.source_repo);
    ensureCloned(target, authedCloneUrlFor(payload.source_repo));
    return target;
  }
  return resolved;
}

/** Prepares a changeset_review ask for a human to actually look at: writes its proposed files into a real local clone -- the same task shard the contributor worked in, when the ask's payload names one (source_repo) and we're in remote mode (cloning/syncing it if needed), falling back to the review's own parent repo otherwise -- and computes a real diff against baseCommit, so a Maintainer can `cd` in and run the code, not just read a model's decision. Calls no model and claims nothing; proposeReview/acceptReview (below) own the protocol side. Safe to call more than once (idempotent: a second call reuses and fast-forwards the same named worktree rather than creating a second one, and the file write just overwrites with the same content). A *named*, persistent worktree (ensureNamedWorktree), not an ephemeral one -- this exists specifically so a human can `cd` in and run the code after this returns, possibly across more than one --assist turn on the same ask; an auto-removed worktree would delete the thing this function exists to produce. */
export async function prepareReviewWorkspace(opts: ScriptedFlowOptions): Promise<ReviewWorkspace> {
  const { resolved, theAsk, authedCloneUrlFor } = opts;
  const payload = theAsk.payload as ChangesetReviewPayload;
  const repo = resolveReviewTarget(resolved, payload, authedCloneUrlFor);
  const target = ensureNamedWorktree(repo, `review-${theAsk.id}`, "HEAD");
  writeFilesToWorkingTree(target, payload.files);
  const diff = payload.baseCommit
    ? diffFileSets(
        payload.files.map((f) => ({ path: f.path, content: fileContentAtCommit(target.repoDir, payload.baseCommit!, f.path) })),
        payload.files,
      )
    : payload.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  return { repoDir: target.repoDir, diff: diff || "(identical to base -- nothing changed)" };
}

/** Claim (if needed) and draft a decision -- doesn't post anything. --assist (cli/commands/work.ts) shows `decision`/`reason` to a human, who may accept as-is or override either field, then calls acceptReview; runChangesetReview (below) just calls both back to back, unchanged behavior from before this split. */
export async function proposeReview(opts: ScriptedFlowOptions): Promise<ReviewProposal> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, onPartial, callTool = localCallTool, authedCloneUrlFor } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as ChangesetReviewPayload;

  // Independently re-verify it actually runs -- never trust the
  // contributor's own earlier sandbox pass as the final word (the same
  // "never trust self-declared scope" principle this review step
  // already exists for, site/content/governance/index.md, extended to
  // "never trust a self-declared passing test run" too). An objective
  // fact, not a judgment call, so a sandbox failure here skips the
  // model's own review entirely and denies outright -- acceptReview's
  // own deny-branch (below) already turns a deny into a fresh "work"
  // ask carrying this exact failure as feedback, so the retry loop
  // closes automatically on zz work's very next poll, no restart or
  // human intervention needed. Same source_repo/shard resolution
  // prepareReviewWorkspace uses (resolveReviewTarget, above), since a
  // sharded task's proposed files assume that shard's own base, not the
  // parent repo's. No worktree wrap needed here, unlike that function --
  // verifyProposal only ever reads `target.slug`, never `target.repoDir`
  // as a path; the actual isolated checkout happens inside
  // run_in_sandbox (agent/tools.ts), which already resolves and isolates
  // its own worktree off that slug.
  const target = resolveReviewTarget(resolved, payload, authedCloneUrlFor);
  const sandboxResult = await verifyProposal(target, payload.files);
  if (sandboxResult.exitCode !== 0) {
    return {
      decision: "request_changes",
      reason: `Sandbox verification failed at review time (exit ${sandboxResult.exitCode}):\n${sandboxResult.stdout}\n${sandboxResult.stderr}`.slice(0, 1000),
    };
  }

  const diffBlob = payload.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  const prompt = `Task that was asked for:\n${payload.taskDescription}\n\nProposed commit message: ${payload.message}\nContributor's own summary (verify this independently, don't just trust it): ${payload.summary}\n\nActual proposed file contents:\n${diffBlob}`;
  const text = await generateText(backend, CHANGESET_REVIEW_SYSTEM_PROMPT, prompt, onLog, onPartial);
  return parseReviewDecision(text);
}

const CHANGESET_DISCUSS_SYSTEM_PROMPT = `You are an agent in the zz coordination system, acting as a Maintainer discussing a proposed changeset with the human who will make the final approve/request_changes call. You already gave an initial recommendation; the human is now asking a follow-up question or pushing back on it. Answer plainly and specifically about the real file contents and the task -- don't repeat your whole earlier analysis, just address what they're asking. Free-form prose is fine here (this is discussion, not the final decision) -- no DECISION:/REASON: format, no tool calls.`;

/** Free-form Q&A about a changeset_review before the human finalizes it -- unlike proposeReview, this doesn't produce a DECISION:/REASON: pair, just an answer to append to the chat transcript. `conversation` is the prior turns (proposeReview's own initial recommendation counts as the first assistant turn) so follow-up questions have context. */
export async function discussReview(opts: ScriptedFlowOptions, conversation: { role: "assistant" | "user"; content: string }[], question: string): Promise<string> {
  const { theAsk, backend, onLog, onPartial } = opts;
  const payload = theAsk.payload as ChangesetReviewPayload;
  const diffBlob = payload.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  const history = conversation.map((t) => `${t.role === "assistant" ? "You" : "Human"}: ${t.content}`).join("\n\n");
  const prompt = `Task that was asked for:\n${payload.taskDescription}\n\nProposed commit message: ${payload.message}\nContributor's own summary: ${payload.summary}\n\nActual proposed file contents:\n${diffBlob}\n\nConversation so far:\n${history}\n\nHuman: ${question}`;
  return generateText(backend, CHANGESET_DISCUSS_SYSTEM_PROMPT, prompt, onLog, onPartial);
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
  //
  // The original "work" ask is already answered complete by this point
  // (acceptContributorWork answers it the moment a changeset is
  // submitted for review, not gated on the review's outcome -- an ask
  // can never be un-answered, engine/lane.ts's answer() rejects a
  // second one outright), so "request changes" would otherwise be a
  // dead end: nothing claimable anywhere ever reflects that feedback.
  // Posting a fresh "work" ask here, with the rejected draft and the
  // reason folded into its description, is what actually gets it back
  // in front of a contributor (the same one or a different one) to
  // revise -- a plain "work" ask, not a new kind, so every existing
  // path that already knows how to handle one (zz work's autonomous
  // loop, --assist) picks it up with no special-casing.
  const payload = theAsk.payload as ChangesetReviewPayload;
  // description stays short and clean (the UI's own describeAsk, plus
  // proposeContributorWork's shard-naming/Ladder-search, all read this
  // field expecting a one-line task summary, not a wall of code) --
  // the rejected draft and the reason live in priorAttempt instead,
  // which proposeContributorWork folds into the model's own prompt
  // without it ever reaching a display surface.
  const followup = (await callTool("ask_post", {
    repo: resolved.slug,
    lane_id: laneId,
    kind: "work",
    from: agent,
    payload: {
      description: payload.taskDescription,
      priorAttempt: { reason: proposal.reason, files: payload.files },
    },
    depends_on: [],
  })) as AskEntry;
  onLog(`[scripted] requested changes on changeset_review ${theAsk.id}: ${proposal.reason} -- its submit_changeset stays permanently blocked; posted a new work ask (${followup.id}) with the feedback for whoever picks it up next`);
}

export async function runChangesetReview(opts: ScriptedFlowOptions): Promise<void> {
  const proposal = await proposeReview(opts);
  await acceptReview(opts, proposal);
}
