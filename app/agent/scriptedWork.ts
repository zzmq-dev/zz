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
import { readLane } from "../engine/store.js";
import { fileContentAtCommit } from "../engine/ingest.js";

function findTool(name: string) {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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
  const dropProblem = checkNoDroppedExports(resolved.repoDir, files);
  if (dropProblem) return { exitCode: 1, stdout: "", stderr: dropProblem };
  return (await callTool("run_in_sandbox", {
    repos: [{ repo: resolved.slug, files }],
    command: "node --test",
    cwd: resolved.slug,
  })) as { exitCode: number; stdout: string; stderr: string };
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

export interface ScriptedFlowOptions {
  resolved: ResolvedRepo;
  laneId: string;
  theAsk: AskEntry;
  agent: string;
  alreadyClaimed: boolean;
  backend: ChatBackend;
  onLog: (line: string) => void;
}

const MAX_SANDBOX_ATTEMPTS = 2;

export async function runContributorWorkAsk(opts: ScriptedFlowOptions): Promise<void> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog } = opts;
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
      await callTool("ask_post", {
        repo: resolved.slug,
        lane_id: laneId,
        kind: "submit_changeset",
        from: agent,
        payload: { files: proposal.files, message: proposal.message, summary: proposal.summary },
        depends_on: [theAsk.id],
      });
      await callTool("ask_answer", {
        repo: resolved.slug,
        lane_id: laneId,
        ask_id: theAsk.id,
        actor: agent,
        action: "complete",
        payload: { summary: proposal.summary },
      });
      onLog(`[scripted] sandbox passed -- posted submit_changeset and answered ${theAsk.id} complete`);
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
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as ChangesetPayload;
  try {
    onLog(`[scripted] committing ${payload.files.map((f) => f.path).join(", ")}`);
    const commitResult = (await callTool("commit_changeset", {
      repo: resolved.slug,
      files: payload.files,
      message: payload.message,
      author_name: theAsk.from,
      author_email: `${theAsk.from}@local`,
    })) as { commitOid: string };
    const commitOid = commitResult.commitOid;

    const prompt = `Repo: ${resolved.slug}\nCommit: ${commitOid}\nCommit message: ${payload.message}\nChange summary (from the contributor): ${payload.summary}\n\nFiles:\n${payload.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")}`;
    const text = await generateText(backend, SUMMARIZE_SYSTEM_PROMPT, prompt);
    const { perFile, changeset } = parseSummaries(text);

    const now = new Date().toISOString();
    const source = [{ kind: "commit" as const, ref: commitOid, title: payload.message, author: theAsk.from, at: now }];
    const rungs = [
      ...payload.files.map((f) => ({
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
        children: payload.files.map((f) => ({
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
    // A real race (another change landed first; this proposal was
    // based on the now-stale snapshot), not a bug in the proposal
    // itself -- post it as a visible, claimable ask rather than
    // silently discarding or blindly retrying from scratch, so
    // whoever resolves it can reconcile the two instead of just
    // re-deriving the original task and re-dropping whatever landed.
    const isConflict = err instanceof Error && (err as { conflict?: boolean }).conflict === true;
    if (isConflict) {
      // The original "work" ask's own description (not just the
      // rejected diff) -- lets the resolver treat this as the same
      // "add X to the current file" task that already works reliably,
      // with the rejected proposal as a reference draft, rather than
      // a much harder "merge these two file blobs together" task.
      const originLane = readLane(resolved.stateDir, laneId);
      const originAskId = theAsk.depends_on?.[0];
      const originAsk = originLane?.history.find((e): e is AskEntry => e.type === "ASK" && e.id === originAskId);
      const originalDescription = (originAsk?.payload as { description?: string } | undefined)?.description ?? payload.summary;
      await callTool("ask_post", {
        repo: resolved.slug,
        lane_id: laneId,
        kind: "resolve_conflict",
        from: agent,
        payload: { originalDescription, originalFiles: payload.files, originalMessage: payload.message, originalSummary: payload.summary, reason: message },
        depends_on: [],
      });
      onLog(`[scripted] conflict (another change landed first) -- denied ${theAsk.id}, posted resolve_conflict`);
    } else {
      onLog(`[scripted] failed to commit/write the Ladder, denied ${theAsk.id}: ${message}`);
    }
  }
}

interface ResolveConflictPayload {
  originalDescription: string;
  originalFiles: { path: string; content: string }[];
  originalMessage: string;
  originalSummary: string;
  reason: string;
}

// Framed as the SAME additive task PROPOSE_SYSTEM_PROMPT already
// handles reliably ("here is the current file, add X to it"), not as
// a "merge two file blobs together" task -- observed directly
// (gpt-oss-120b): asked to reconcile two full file versions, it
// anchored on its own rejected draft and dropped an unrelated export
// from the current file identically on both attempts, even when told
// exactly which name it had dropped. The current file is the one
// source of truth being extended; the rejected draft is a reference
// for what to add, not a second version to merge in.
const RESOLVE_CONFLICT_SYSTEM_PROMPT = `You are an agent in the zz coordination system, acting as a contributor. Someone else's change landed in the repo first, so a colleague's draft for a different change (based on the old state) was rejected -- it would have dropped the other change. Your job is the same as any other task: add the colleague's change to the CURRENT file, which you must treat as the one source of truth and preserve in full. The colleague's draft below is a reference for WHAT to add, not a file version to merge in.

You never call tools or write JSON here -- you only write plain text in the exact format below.

Output format, exactly:
SUMMARY: <one sentence describing the change>
MESSAGE: <a short git commit message>
FILE: <path, relative to the repo root>
\`\`\`
<the file's FULL new content -- everything the CURRENT file already has, plus the addition>
\`\`\`
(one FILE block per file that needs to end up changed)

Nothing else -- no prose outside these lines, no explanation, no tool calls.`;

export async function runResolveConflict(opts: ScriptedFlowOptions): Promise<void> {
  const { resolved, laneId, theAsk, agent, alreadyClaimed, backend, onLog } = opts;
  if (!alreadyClaimed) {
    await callTool("ask_claim", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent });
  }

  const payload = theAsk.payload as ResolveConflictPayload;
  const originalBlob = payload.originalFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");

  let lastFailure = "";
  const systemPrompt = RESOLVE_CONFLICT_SYSTEM_PROMPT;
  for (let attempt = 1; attempt <= MAX_SANDBOX_ATTEMPTS; attempt++) {
    // Re-read on every attempt -- see the matching comment in
    // runContributorWorkAsk. Especially relevant here: this whole flow
    // exists because HEAD moved once already; it can move again
    // between retries.
    const currentFiles = currentRepoFiles(resolved);
    const currentBlob = currentFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const userPrompt = `Repo: ${resolved.slug}\n\nTask: ${payload.originalDescription}\n\nCURRENT files (the one source of truth -- preserve everything in these):\n${currentBlob}\n\nA colleague's rejected draft, for reference on what to add (do not copy its version of files that already exist above -- only reuse the new parts it added):\n${originalBlob}`;
    const promptForAttempt = attempt === 1 ? userPrompt : `${userPrompt}\n\nYour previous reconciled proposal's test run failed:\n${lastFailure}`;
    onLog(`[scripted] generating reconciled files (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS})`);
    const text = await generateText(backend, systemPrompt, promptForAttempt);
    const proposal = parseFileProposal(text);
    onLog(`[scripted] reconciled ${proposal.files.map((f) => f.path).join(", ")} -- verifying`);
    const result = await verifyProposal(resolved, proposal.files);
    if (result.exitCode === 0) {
      await callTool("ask_post", {
        repo: resolved.slug,
        lane_id: laneId,
        kind: "submit_changeset",
        from: agent,
        payload: { files: proposal.files, message: proposal.message, summary: proposal.summary },
        depends_on: [theAsk.id],
      });
      await callTool("ask_answer", { repo: resolved.slug, lane_id: laneId, ask_id: theAsk.id, actor: agent, action: "complete", payload: { summary: proposal.summary } });
      onLog(`[scripted] reconciled sandbox passed -- posted submit_changeset and answered ${theAsk.id} complete`);
      return;
    }
    lastFailure = `exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    onLog(`[scripted] reconciled sandbox failed (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS}): ${lastFailure.slice(0, 300)}`);
  }

  await callTool("ask_answer", {
    repo: resolved.slug,
    lane_id: laneId,
    ask_id: theAsk.id,
    actor: agent,
    action: "deny",
    payload: { reason: `sandbox verification failed after ${MAX_SANDBOX_ATTEMPTS} attempts: ${lastFailure.slice(0, 500)}` },
  });
  onLog(`[scripted] gave up reconciling after ${MAX_SANDBOX_ATTEMPTS} failed attempts -- denied ${theAsk.id}`);
}
