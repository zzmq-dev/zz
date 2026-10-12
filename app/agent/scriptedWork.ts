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
import type { ResolvedRepo } from "../cli/lib/repo.js";
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
async function generateText(backend: ChatBackend, systemPrompt: string, userPrompt: string): Promise<string> {
  const message = await backend.chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    [],
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
}): Promise<void> {
  const { resolved, laneId, agent, taskAskId, taskDescription, files, message, summary, baseCommit, callTool } = opts;
  const review = (await callTool("ask_post", {
    repo: resolved.slug,
    lane_id: laneId,
    kind: "changeset_review",
    from: agent,
    payload: { taskDescription, files, message, summary },
    depends_on: [],
  })) as AskEntry;
  await callTool("ask_post", {
    repo: resolved.slug,
    lane_id: laneId,
    kind: "submit_changeset",
    from: agent,
    payload: { files, message, summary, baseCommit },
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

List one FILE block per file you're adding or changing. Nothing else -- no prose outside these lines, no explanation, no tool calls.`;

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
}

const MAX_SANDBOX_ATTEMPTS = 2;

export async function runContributorWorkAsk(opts: ScriptedFlowOptions): Promise<void> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, callTool = localCallTool } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const description = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);

  let proposal: ParsedFileProposal;
  let systemPrompt = PROPOSE_SYSTEM_PROMPT;
  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_SANDBOX_ATTEMPTS; attempt++) {
    // Re-read on every attempt, not just once before the loop -- HEAD
    // can genuinely move between attempts (another agent's commit
    // landing while this one retries), and reusing a stale snapshot
    // across retries was the same bug class as currentRepoFiles
    // reading the working tree: feeding the model outdated context
    // instead of giving it a real chance to account for what changed.
    const baseCommit = currentHeadSha(resolved);
    const files = currentRepoFiles(resolved);
    const contextBlob = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const userPrompt = `Repo: ${resolved.slug}\nTask: ${description}\n\nCurrent files:\n${contextBlob}`;
    const promptForAttempt = attempt === 1 ? userPrompt : `${userPrompt}\n\nYour previous proposal's test run failed:\n${lastFailure}`;
    onLog(`[scripted] generating proposed files (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS})`);
    const text = await generateText(backend, systemPrompt, promptForAttempt);
    proposal = parseFileProposal(text);
    onLog(`[scripted] proposed ${proposal.files.map((f) => f.path).join(", ")} -- verifying`);
    const result = await verifyProposal(resolved, proposal.files);
    if (result.exitCode === 0) {
      await postForReview({ resolved, laneId, agent, taskAskId: theAsk.id, taskDescription: description, files: proposal.files, message: proposal.message, summary: proposal.summary, baseCommit, callTool });
      await callTool("ask_answer", {
        repo: resolved.slug,
        lane_id: laneId,
        ask_id: theAsk.id,
        actor: agent,
        action: "complete",
        payload: { summary: proposal.summary },
      });
      onLog(`[scripted] sandbox passed -- posted for review and answered ${theAsk.id} complete`);
      return;
    }
    lastFailure = `exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    onLog(`[scripted] sandbox failed (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS}): ${lastFailure.slice(0, 300)}`);
    systemPrompt = FIX_SYSTEM_PROMPT;
  }

  await callTool("ask_answer", {
    repo: resolved.slug,
    lane_id: laneId,
    ask_id: theAsk.id,
    actor: agent,
    action: "deny",
    payload: { reason: `sandbox verification failed after ${MAX_SANDBOX_ATTEMPTS} attempts: ${lastFailure.slice(0, 500)}` },
  });
  onLog(`[scripted] gave up after ${MAX_SANDBOX_ATTEMPTS} failed sandbox attempts -- denied ${theAsk.id}`);
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

export async function runChangesetReview(opts: ScriptedFlowOptions): Promise<void> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog, callTool = localCallTool } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as ChangesetReviewPayload;
  const diffBlob = payload.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  const prompt = `Task that was asked for:\n${payload.taskDescription}\n\nProposed commit message: ${payload.message}\nContributor's own summary (verify this independently, don't just trust it): ${payload.summary}\n\nActual proposed file contents:\n${diffBlob}`;
  const text = await generateText(backend, CHANGESET_REVIEW_SYSTEM_PROMPT, prompt);
  const { decision, reason } = parseReviewDecision(text);

  if (decision === "approve") {
    await callTool("ask_answer", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent, action: "grant", payload: { reason } });
    onLog(`[scripted] approved changeset_review ${theAsk.id}: ${reason}`);
    return;
  }

  await callTool("ask_answer", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent, action: "deny", payload: { reason } });
  // The gated submit_changeset is now permanently unclaimable (its
  // depends_on will never resolve) -- a real, visible terminal state
  // in the lane log, not denied outright here: denying it is a
  // coordinator-scope action, and a Maintainer doing the reviewing is
  // deliberately not required to also be a coordinator (that's the
  // whole point of narrowing maintainers to e.g. a single human actor
  // who approves but never merges).
  onLog(`[scripted] requested changes on changeset_review ${theAsk.id}: ${reason} -- its submit_changeset stays permanently blocked`);
}
