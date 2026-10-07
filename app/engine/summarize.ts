// Shells out to the Claude CLI itself (`claude -p`) to read file content
// and conversation threads and produce an actual summary -- the same
// model and capability as doing this by hand in a session, just invoked
// headlessly. Every rung this touches gets a genuine summary or the
// pipeline reports a failure, not a stub saying the content wasn't read.
import { execFileSync } from "node:child_process";

function askClaude(prompt: string): string {
  return execFileSync("claude", ["-p", prompt], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  }).trim();
}

let warmedUp = false;

/**
 * A throwaway call to flush any one-time startup notice (a background
 * connector check has been observed appended to the first `claude -p`
 * call's output in a fresh shell) before any result that actually gets
 * stored. Call this once before a batch of summarization calls.
 */
export function warmUp(): void {
  if (warmedUp) return;
  warmedUp = true;
  try {
    askClaude("Reply with just: ok");
  } catch {
    // If this fails, the calls below will fail too and surface the error there.
  }
}

/** A tiny concurrency limiter so a big repo doesn't spawn hundreds of `claude -p` processes at once. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const run = queue.shift()!;
    run();
  }
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}

export async function summarizeFile(path: string, content: string): Promise<string> {
  const trimmed = content.trim();
  if (!trimmed) return "Empty file.";
  const prompt = `You are writing one specific entry in a maintainer's reference for a codebase. Describe in 1-3 sentences what this file does: its purpose, and its key exported functions/classes by name. Be concrete -- name functions and behavior, not generic description. No caveats, no mention of being an AI, no markdown formatting.

File: ${path}
---
${trimmed.slice(0, 16_000)}
---
One to three sentence summary:`;
  return askClaude(prompt);
}

export interface ThreadComment {
  author: string;
  body: string;
}

/**
 * Summarizes an issue/PR thread the way a human reading it would: what's
 * actually being asked, and (if resolved) what happened. Classified in zz
 * protocol vocabulary (Ask/Answer) per the project's own decision to model
 * onboarded GitHub content that way.
 */
export async function summarizeThread(input: {
  kind: "issue" | "pr";
  number: number;
  title: string;
  body: string;
  state: string;
  mergedOrClosed: string;
  comments: ThreadComment[];
}): Promise<string> {
  const threadText = input.comments.map((c) => `${c.author}: ${c.body}`).join("\n---\n");
  const prompt = `You are writing one entry in a maintainer's reference, modeling a GitHub ${input.kind} as a zz-protocol Ask: the opening post is the Ask, replies are Answers. Read the thread below and describe in 2-4 sentences what was asked, what the back-and-forth was about, and what happened (fixed, rejected, duplicate, abandoned, etc. -- the outcome is: ${input.mergedOrClosed}). Be concrete about the technical content, not a restatement of the title. No caveats, no mention of being an AI, no markdown formatting.

#${input.number}: ${input.title}
Opening post:
${input.body || "(no body)"}

Thread:
${threadText || "(no comments)"}
---
Summary:`;
  return askClaude(prompt);
}

export async function summarizeContributor(login: string, commitMessages: string[]): Promise<string> {
  if (commitMessages.length === 0) return `${login}: no commit messages available to summarize.`;
  const prompt = `You are writing one entry in a maintainer's reference describing what a contributor worked on, based on their commit messages below. In 1-2 sentences, describe the specific areas or kinds of changes they made -- not a restatement that they "made commits." No caveats, no mention of being an AI, no markdown formatting.

Contributor: ${login}
Commit messages (most recent first):
${commitMessages.slice(0, 60).join("\n")}
---
One to two sentence summary:`;
  return askClaude(prompt);
}

export async function summarizeDependencyUsage(name: string, usageSnippets: { file: string; line: string }[]): Promise<string> {
  if (usageSnippets.length === 0) return `${name}: declared in package.json; no usage sites found by search.`;
  const snippetText = usageSnippets
    .slice(0, 20)
    .map((s) => `${s.file}: ${s.line.trim()}`)
    .join("\n");
  const prompt = `You are writing one entry in a maintainer's reference describing how a dependency is used in this codebase, based on the source lines below where it's imported/required. In 1-2 sentences, describe what it's used for here. No caveats, no mention of being an AI, no markdown formatting.

Dependency: ${name}
Usage sites:
${snippetText}
---
One to two sentence summary:`;
  return askClaude(prompt);
}
