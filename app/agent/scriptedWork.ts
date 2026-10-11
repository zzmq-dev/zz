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
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ChatBackend } from "./chatBackend.js";
import { ALL_TOOLS } from "./tools.js";
import type { ResolvedRepo } from "../cli/lib/repo.js";
import type { AskEntry } from "../engine/types.js";

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

// All real, small, tracked files -- not git-notes/Ladder paths (those
// aren't real files to read via fs). Demo-repo sized, so dumping every
// file's full content is cheap; a larger repo would need this to be
// selective instead, which is a real limitation worth flagging if this
// pattern grows beyond the demo repos.
function currentRepoFiles(resolved: ResolvedRepo): { path: string; content: string }[] {
  const listing = execFileSync("git", ["-C", resolved.repoDir, "ls-files"], { encoding: "utf8" });
  return listing
    .split("\n")
    .filter(Boolean)
    .map((path) => ({ path, content: readFileSync(`${resolved.repoDir}/${path}`, "utf8") }));
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

  const files = currentRepoFiles(resolved);
  const contextBlob = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  const description = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);
  const userPrompt = `Repo: ${resolved.slug}\nTask: ${description}\n\nCurrent files:\n${contextBlob}`;

  let proposal: ParsedFileProposal;
  let systemPrompt = PROPOSE_SYSTEM_PROMPT;
  let promptForAttempt = userPrompt;
  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_SANDBOX_ATTEMPTS; attempt++) {
    onLog(`[scripted] generating proposed files (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS})`);
    const text = await generateText(backend, systemPrompt, promptForAttempt);
    proposal = parseFileProposal(text);
    onLog(`[scripted] proposed ${proposal.files.map((f) => f.path).join(", ")} -- verifying in sandbox`);
    const result = (await callTool("run_in_sandbox", {
      repos: [{ repo: resolved.slug, files: proposal.files }],
      command: "node --test",
      cwd: resolved.slug,
    })) as { exitCode: number; stdout: string; stderr: string };
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
    promptForAttempt = `${userPrompt}\n\nYour previous proposal's test run failed:\n${lastFailure}`;
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
    onLog(`[scripted] failed to commit/write the Ladder, denied ${theAsk.id}: ${message}`);
  }
}
