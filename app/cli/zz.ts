#!/usr/bin/env node
// Loads app/.env if present (e.g. GEMINI_API_KEY) -- never commit that
// file (already in .gitignore); quiet no-op when it doesn't exist.
try {
  process.loadEnvFile();
} catch {
  // no .env file -- fine, env vars can still be set the normal way
}
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerLocalBackendFactory } from "../engine/backend.js";
import { createLocalBackend } from "../engine/localBackend.js";
import { ladderBuild } from "./commands/ladder-build.js";
import { ladderDump, type DumpFormat } from "./commands/ladder-dump.js";
import { ladderReplayCommits } from "./commands/ladder-replay-commits.js";
import { laneLog, type LaneLogFormat } from "./commands/lane-log.js";
import { work } from "./commands/work.js";
import { workAssist } from "./commands/workAssist.js";
import { top } from "./commands/top.js";
import { askPost } from "./commands/ask-post.js";
import { review } from "./commands/review.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { agentCreate, agentToken, agentList } from "./commands/agent.js";
import { repoCreate, repoList, repoGrant, repoAsk, repoAsks, repoClone } from "./commands/repo.js";
import { repoSubmit } from "./commands/repo-submit.js";
import { askClaim } from "./commands/ask-claim.js";
import { ladderEdit } from "./commands/ladder-edit.js";

registerLocalBackendFactory(createLocalBackend);

// Reads package.json's own version rather than a hardcoded literal --
// `npm version` is the one standard place a release bump happens, so
// this is the one place that reads it back, instead of a second
// string that's easy to forget to update alongside it. Walks upward
// (not a fixed "../.." relative offset) because this file sits at a
// different depth relative to the package root in dev (cli/zz.ts) vs.
// built (dist/cli/zz.js) -- a fixed offset would be right for only one
// of the two.
function readOwnVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "package.json");
    try {
      return (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version ?? "0.0.0";
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return "0.0.0"; // reached filesystem root -- shouldn't happen, fail soft
      dir = parent;
    }
  }
}

const version = readOwnVersion();

// The "v2.0.0" token is the one place a real version gets spliced in --
// everything else here is verbatim ASCII art, not a generated/figlet
// call, so it always renders pixel-for-pixel the same regardless of
// terminal font. String.raw so every backslash below is taken
// literally (no escaping needed to match the art exactly).
const BANNER = String.raw`
   __/\\\\\\\\\\\__/\\\\\\\\\\\___________________
    _\///////\\\/__\///////\\\/____________________
     ______/\\\/_________/\\\/___________v2.0.0_____
      ____/\\\/_________/\\\/________________________
       __/\\\\\\\\\\\__/\\\\\\\\\\\__/\\\\\\\\\\\\\\\_
        _\///////////__\///////////__\///////////////__`.replace("v2.0.0", `v${version}`);

// --version's own default (the banner, same as --help) only makes
// sense for a human; --simple keeps the old bare-string behavior for
// scripts/automation that parse `zz --version`'s output, so neither
// use case had to change behavior out from under the other. Checked
// directly against argv, ahead of commander's own parsing, since
// commander's built-in .version() has no hook for "print something
// else based on a second flag" -- this is simpler than fighting it.
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(process.argv.includes("--simple") ? version : BANNER);
  process.exit(0);
}

const program = new Command();
program.name("zz").description("zz: a coordination layer for agentic open source").version(version);
program.addHelpText("before", `${BANNER}\n`);
program.option("--simple", "with --version, print just the bare version string (for scripts)");

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

ladder
  .command("edit <repo> <path>")
  .description('write one Ladder rung by hand -- e.g. after a manual commit, describe what changed at the repo/file/function level. Anchors to the current directory\'s HEAD commit unless --commit is given.')
  .requiredOption("--kind <kind>", "repo, file, function, lines, release, package, changeset, filechange, linechange, contributor, or dependencies")
  .requiredOption("--summary <text>", "what this rung describes, holistically -- not just what changed")
  .option("--commit <sha>", "anchor to this commit instead of the current directory's HEAD")
  .option("--as <name>", "write as a managed agent instead of yourself")
  .action(async (repo: string, path: string, opts: { kind: string; summary: string; commit?: string; as?: string }) => {
    await ladderEdit(repo, path, opts);
  });

const lane = program.command("lane").description("inspect the Lane/ASK/ANSWER protocol trail");

lane
  .command("log <repo>")
  .description("chronological log of every ASK/ANSWER across every Lane for a repo")
  .option("--format <format>", "text or json", "text")
  .option("--lane <id>", "show only one lane")
  .option("--out <path>", "write to a file instead of stdout")
  .option("--local", "read the original local/demo backend instead of the default: the deployed Worker's real protocol state")
  .action(async (repo: string, opts: { format: string; lane?: string; out?: string; local?: boolean }) => {
    const format = opts.format as LaneLogFormat;
    if (format !== "text" && format !== "json") {
      console.error(`unknown format "${opts.format}"; expected text or json`);
      process.exitCode = 1;
      return;
    }
    await laneLog(repo, { format, lane: opts.lane, out: opts.out, local: opts.local });
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

askCmd
  .command("claim <repo> <ask-id>")
  .description("claim an Ask by hand and open a new Lane for the work (prints its id) -- the manual-CLI counterpart to an agent's own claim step")
  .option("--lane <id>", 'which Lane the ask lives in (default: "_repo", where `zz repo ask` always posts)')
  .option("--as <name>", "claim as a managed agent instead of yourself")
  .action(async (repo: string, askId: string, opts: { lane?: string; as?: string }) => {
    await askClaim(repo, askId, opts);
  });

program
  .command("work [repo]")
  .description("headless work loop: continuously claims and works whatever Asks your identity is permitted to act on. [repo] is shorthand for --repos <repo> (a single owner/repo); omit both to use ~/.zz/config.json's list. For a headless run with no `zz login` session at all, set ZZ_ID=\"<username>:<token>\" (or ZZ_ID_FILE=<path to a file with that same text>) instead of --as/--agent.")
  .option("--as <name>", 'act as a managed agent instead of yourself, e.g. "--as claude" -- expands to "<your username>[claude]", using the token `zz agent create`/`zz agent token` already saved locally for it (see `zz agent --help`). Omit to act as yourself (your own `zz login` session).')
  .option("--agent <id>", "your agent identity by its exact username (default: --as, else your own login, else ~/.zz/config.json) -- --as is the normal way to do this, this stays mainly for the --local path")
  .option("--repos <list>", "comma-separated owner/repo list (default: from ~/.zz/config.json) -- ignored if [repo] is given", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .option("--scope <scope>", "coordinator, contributor, or all (default: all)", "all")
  .option("--stdio", "one flat combined log stream instead of the live TUI")
  .option("--max-turns <n>", "stop a single claimed Ask after this many tool-calling turns (default: 60)", (v) => parseInt(v, 10))
  .option("--poll-ms <n>", "how often to recheck for claimable work when idle (default: 1000)", (v) => parseInt(v, 10))
  .option("--provider <name>", "ollama (local, default), gemini, groq, or cloudflare (remote, each needs its own API key -- see app/.env)")
  .option("--model <name>", 'model name for whichever provider -- default is "qwen2.5:14b-instruct" (ollama), "gemini-3.8-flash" (gemini), "openai/gpt-oss-120b" (groq), or "@cf/meta/llama-3.3-70b-instruct-fp8-fast" (cloudflare). Run `zz models` to see what\'s available locally for ollama.')
  .option("--local", "use the original local/demo backend (a real local clone, state in .zz/) instead of the default: your resolved identity's real protocol state on the deployed Worker")
  .option(
    "--assist",
    "a human-in-the-loop TUI instead of the headless loop: pick a claimable work/changeset_review ask from the repos you're watching (same resolution as `zz top`), chat with the model about its draft/recommendation, then explicitly submit it back as a real ANSWER. Never clones anything until you've picked an ask. Ignores --stdio/--poll-ms/--max-turns.",
  )
  .action(async (repo: string | undefined, opts: { as?: string; agent?: string; repos?: string[]; scope?: string; stdio?: boolean; maxTurns?: number; pollMs?: number; model?: string; provider?: string; local?: boolean; assist?: boolean }) => {
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
    if (opts.assist) {
      await workAssist({
        as: opts.as,
        agent: opts.agent,
        repos: repo ? [repo] : opts.repos,
        scope: opts.scope as "coordinator" | "contributor" | "all" | undefined,
        model: opts.model,
        provider: opts.provider as "ollama" | "gemini" | "groq" | "cloudflare" | undefined,
        local: opts.local,
      });
      return;
    }
    await work({
      as: opts.as,
      agent: opts.agent,
      repos: repo ? [repo] : opts.repos,
      scope: opts.scope as "coordinator" | "contributor" | "all" | undefined,
      stdio: opts.stdio,
      maxTurns: opts.maxTurns,
      pollMs: opts.pollMs,
      model: opts.model,
      provider: opts.provider as "ollama" | "gemini" | "groq" | "cloudflare" | undefined,
      local: opts.local,
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
  .option("--local", "use the original local/demo backend instead of the default: your resolved identity's real protocol state on the deployed Worker")
  .action(async (opts: { repos?: string[]; local?: boolean }) => {
    await top({ repos: opts.repos, local: opts.local });
  });

program
  .command("review [repo]")
  .description('interactive queue for a human to approve/request-changes on changeset_review asks -- the HITL slice of "zz cowork": claim/grant/deny are handled for you, you just judge. [repo] is shorthand for --repos <repo>')
  .option("--as <name>", 'act as a managed agent instead of yourself, e.g. "--as claude" -- see `zz work --help`')
  .option("--agent <id>", "your agent identity by its exact username (default: --as, else your own login, else ~/.zz/config.json)")
  .option("--repos <list>", "comma-separated owner/repo list (default: from ~/.zz/config.json) -- ignored if [repo] is given", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .option("--local", "use the original local/demo backend instead of the default: your resolved identity's real protocol state on the deployed Worker")
  .action(async (repo: string | undefined, opts: { as?: string; agent?: string; repos?: string[]; local?: boolean }) => {
    await review({ as: opts.as, agent: opts.agent, repos: repo ? [repo] : opts.repos, local: opts.local });
  });

program
  .command("login")
  .description("log in to the remote (Cloudflare) backend -- opens a browser, waits for you to finish, saves a token to ~/.zz/credentials.json. Same identity model either way: a human login and an agent's bearer token are both just an Agent's credential.")
  .option("--api-base <url>", "override the Worker URL (default: ~/.zz/credentials.json's, or the built-in default)")
  .action(async (opts: { apiBase?: string }) => {
    await login({ apiBase: opts.apiBase });
  });

program
  .command("logout")
  .description("drop the local ~/.zz/credentials.json -- for testing the not-logged-in experience, or switching which account you're acting as")
  .action(() => {
    logout();
  });

const agentCmd = program.command("agent").description("manage Agents on the remote backend -- full parity with /profile's agent section");

agentCmd
  .command("create <name>")
  .description("create a new peer Agent (any already-authenticated Agent can do this -- see git-compatibility docs for the identity model)")
  .action(async (name: string) => {
    await agentCreate(name);
  });

agentCmd
  .command("token <username>")
  .description("mint a bearer token for an Agent -- yourself, or one you created (practical bootstrap, not a general override)")
  .action(async (username: string) => {
    await agentToken(username);
  });

agentCmd
  .command("list")
  .description("list yourself and the Agents you've created")
  .action(async () => {
    await agentList();
  });

const repoCmd = program.command("repo").description("manage repos on the remote backend -- full parity with /profile and /explore");

repoCmd
  .command("create <name>")
  .description("create a repo, owned by you or an Agent you created")
  .option("--description <text>", "repo description")
  .option("--owner <username>", "owning Agent's username (default: you)")
  .action(async (name: string, opts: { description?: string; owner?: string }) => {
    await repoCreate(name, { description: opts.description, ownerUsername: opts.owner });
  });

repoCmd
  .command("list [query]")
  .description("list recent repos, or search by name/owner/description if a query is given")
  .action(async (query?: string) => {
    await repoList(query);
  });

repoCmd
  .command("grant <owner/repo> <principal> <role>")
  .description("grant an Agent (by username, e.g. thoward37@gmail.com[claude]) a repo Role -- owner, maintainer, contributor, or viewer. Needs Owner on the repo yourself.")
  .action(async (slug: string, principal: string, role: string) => {
    await repoGrant(slug, principal, role);
  });

repoCmd
  .command("ask <owner/repo> <description>")
  .description("post a work Ask to a repo's root Lane")
  .action(async (slug: string, description: string) => {
    await repoAsk(slug, description);
  });

repoCmd
  .command("asks <owner/repo>")
  .description("show a repo's root Lane history (every ASK/ANSWER/INSIGHT posted so far)")
  .action(async (slug: string) => {
    await repoAsks(slug);
  });

repoCmd
  .command("clone <owner/repo> [dir]")
  .description("git clone a repo with your zz login token embedded automatically -- no need to paste it into a username/password prompt by hand")
  .action(async (slug: string, dir?: string) => {
    await repoClone(slug, dir);
  });

repoCmd
  .command("submit <owner/repo> <lane-id> <ask-id>")
  .description("the human-contributor path: from inside your local clone, after editing files and `git add`ing them, post the changeset for review and complete the Ask -- the same protocol sequence a scripted agent follows, just with real file content off disk instead of generated")
  .option("--message <text>", "commit message / summary (default: a generated one naming the staged files)")
  .option("--as <name>", 'submit as a managed agent instead of yourself, e.g. "--as claude" -- see `zz work --help`')
  .action(async (slug: string, laneId: string, askId: string, opts: { message?: string; as?: string }) => {
    await repoSubmit(slug, laneId, askId, { message: opts.message, as: opts.as });
  });

// Any command whose action handler throws (readConfig's "no usable
// config", requireCredentials' "not logged in", a network error, ...)
// otherwise surfaces as a raw, multi-line unhandled-rejection dump --
// the exact bug class that started this round of fixes (`zz top`
// crashing instead of printing guidance). commander's own usage
// errors (bad flags, --help) are unaffected -- those are handled
// internally and never reach this .catch.
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`zz: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
