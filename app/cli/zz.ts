#!/usr/bin/env node
// Loads app/.env if present (e.g. GEMINI_API_KEY) -- never commit that
// file (already in .gitignore); quiet no-op when it doesn't exist.
try {
  process.loadEnvFile();
} catch {
  // no .env file -- fine, env vars can still be set the normal way
}
import { Command } from "commander";
import { ladderBuild } from "./commands/ladder-build.js";
import { ladderDump, type DumpFormat } from "./commands/ladder-dump.js";
import { ladderReplayCommits } from "./commands/ladder-replay-commits.js";
import { laneLog, type LaneLogFormat } from "./commands/lane-log.js";
import { work } from "./commands/work.js";
import { top } from "./commands/top.js";
import { askPost } from "./commands/ask-post.js";

const program = new Command();
program.name("zz").description("zz: a coordination layer for agentic open source").version("0.1.0");

const ladder = program.command("ladder").description("build and read a repo's Ladder");

ladder
  .command("build <repo>")
  .description("onboard a real GitHub repo (owner/repo) into a Ladder, from its real git history and issue/PR/release data")
  .option("--force", "rebuild the file tree and overwrite any existing asks/releases/contributors instead of leaving them alone")
  .action(async (repo: string, opts: { force?: boolean }) => {
    await ladderBuild(repo, { force: opts.force });
  });

ladder
  .command("dump <repo>")
  .description("materialize an onboarded repo's Ladder for reading")
  .option("--format <format>", "text, json, or html", "text")
  .option("--out <path>", "write to a file instead of stdout")
  .action(async (repo: string, opts: { format: string; out?: string }) => {
    const format = opts.format as DumpFormat;
    if (format !== "text" && format !== "json" && format !== "html") {
      console.error(`unknown format "${opts.format}"; expected text, json, or html`);
      process.exitCode = 1;
      return;
    }
    await ladderDump(repo, { format, out: opts.out });
  });

ladder
  .command("replay-commits <repo>")
  .description("walk the commit log from the root commit forward, one Lane per commit, building changeset/filechange/linechange rungs")
  .option("--limit <n>", "only replay the first N not-yet-onboarded commits", (v) => parseInt(v, 10))
  .option("--force", "re-replay commits that already have a changeset rung")
  .option("--max-files <n>", "commits touching more files than this get a mechanical summary instead of per-file/per-hunk analysis (default: 25)", (v) => parseInt(v, 10))
  .action(async (repo: string, opts: { limit?: number; force?: boolean; maxFiles?: number }) => {
    await ladderReplayCommits(repo, { limit: opts.limit, force: opts.force, maxFiles: opts.maxFiles });
  });

const lane = program.command("lane").description("inspect the Lane/ASK/ANSWER protocol trail");

lane
  .command("log <repo>")
  .description("chronological log of every ASK/ANSWER across every Lane for a repo")
  .option("--format <format>", "text or json", "text")
  .option("--lane <id>", "show only one lane")
  .option("--out <path>", "write to a file instead of stdout")
  .action(async (repo: string, opts: { format: string; lane?: string; out?: string }) => {
    const format = opts.format as LaneLogFormat;
    if (format !== "text" && format !== "json") {
      console.error(`unknown format "${opts.format}"; expected text or json`);
      process.exitCode = 1;
      return;
    }
    await laneLog(repo, { format, lane: opts.lane, out: opts.out });
  });

const askCmd = program.command("ask").description("post Asks into a Lane's queue by hand");

askCmd
  .command("post <repo> <lane>")
  .description('post an Ask into a Lane\'s queue -- e.g. --kind work --description "..." for the common case a zz work loop will pick up')
  .option("--kind <kind>", 'Ask kind (default: "work")')
  .option("--from <agent>", 'who it\'s from (default: "human")')
  .option("--description <text>", 'shorthand for payload { description: text } -- what kind "work" expects')
  .option("--payload <json>", "raw JSON payload, for any other kind")
  .option("--priority <n>", "higher = more urgent at query time", (v) => parseInt(v, 10))
  .action(async (repo: string, laneId: string, opts: { kind?: string; from?: string; description?: string; payload?: string; priority?: number }) => {
    await askPost(repo, laneId, opts);
  });

program
  .command("work")
  .description("headless work loop: continuously claims and works whatever Asks your identity is permitted to act on, across every repo in your zz config")
  .option("--agent <id>", "your agent identity (default: from ~/.zz/config.json)")
  .option("--repos <list>", "comma-separated owner/repo list (default: from ~/.zz/config.json)", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .option("--scope <scope>", "coordinator, contributor, or all (default: all)", "all")
  .option("--stdio", "one flat combined log stream instead of the live TUI")
  .option("--max-turns <n>", "stop a single claimed Ask after this many tool-calling turns (default: 60)", (v) => parseInt(v, 10))
  .option("--poll-ms <n>", "how often to recheck for claimable work when idle (default: 1000)", (v) => parseInt(v, 10))
  .option("--provider <name>", "ollama (local, default), gemini, groq, or cloudflare (remote, each needs its own API key -- see app/.env)")
  .option("--model <name>", 'model name for whichever provider -- default is "qwen2.5:14b-instruct" (ollama), "gemini-3.8-flash" (gemini), "openai/gpt-oss-120b" (groq), or "@cf/meta/llama-3.3-70b-instruct-fp8-fast" (cloudflare). Run `zz models` to see what\'s available locally for ollama.')
  .action(async (opts: { agent?: string; repos?: string[]; scope?: string; stdio?: boolean; maxTurns?: number; pollMs?: number; model?: string; provider?: string }) => {
    if (opts.scope && !["coordinator", "contributor", "all"].includes(opts.scope)) {
      console.error(`unknown --scope "${opts.scope}"; expected coordinator, contributor, or all`);
      process.exitCode = 1;
      return;
    }
    if (opts.provider && !["ollama", "gemini", "groq", "cloudflare"].includes(opts.provider)) {
      console.error(`unknown --provider "${opts.provider}"; expected ollama, gemini, groq, or cloudflare`);
      process.exitCode = 1;
      return;
    }
    await work({
      agent: opts.agent,
      repos: opts.repos,
      scope: opts.scope as "coordinator" | "contributor" | "all" | undefined,
      stdio: opts.stdio,
      maxTurns: opts.maxTurns,
      pollMs: opts.pollMs,
      model: opts.model,
      provider: opts.provider as "ollama" | "gemini" | "groq" | "cloudflare" | undefined,
    });
  });

program
  .command("models")
  .description("list Ollama models available locally, for --model")
  .action(async () => {
    const baseUrl = process.env.ZZ_OLLAMA_HOST ?? "http://localhost:11434";
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) {
      console.error(`could not reach ollama at ${baseUrl}: ${res.status}`);
      process.exitCode = 1;
      return;
    }
    const data = (await res.json()) as { models: { name: string; size: number; details: { parameter_size?: string } }[] };
    const current = process.env.ZZ_OLLAMA_MODEL ?? "qwen2.5:14b-instruct";
    for (const m of data.models) {
      const sizeGb = (m.size / 1e9).toFixed(1);
      console.log(`${m.name === current ? "* " : "  "}${m.name.padEnd(45)} ${sizeGb.padStart(6)}GB  ${m.details.parameter_size ?? "?"}`);
    }
    console.log(`\n* = current default (ZZ_OLLAMA_MODEL, or qwen2.5:14b-instruct). Pick one with: zz work --model <name>`);
  });

program
  .command("top")
  .description("real-time dashboard over every Lane in the repos from your zz config -- lanes overview + a live, filterable protocol feed")
  .option("--repos <list>", "comma-separated owner/repo list (default: from ~/.zz/config.json)", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .action(async (opts: { repos?: string[] }) => {
    await top({ repos: opts.repos });
  });

program.parseAsync(process.argv);
