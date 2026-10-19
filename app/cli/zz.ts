#!/usr/bin/env node
// Loads app/.env if present (e.g. GEMINI_API_KEY) -- never commit that
// file (already in .gitignore); quiet no-op when it doesn't exist.
try {
  process.loadEnvFile();
} catch {
  // no .env file -- fine, env vars can still be set the normal way
}
import { Command } from "commander";
import { version, BANNER } from "./lib/banner.js";
import { registerLocalBackendFactory } from "../engine/backend.js";
import { ORIGIN_LANE_ID } from "../engine/lane.js";
import { createLocalBackend } from "../engine/localBackend.js";
import { ladderBuild } from "./commands/ladder-build.js";
import type { Provider } from "./lib/resolveChatBackend.js";
import { ladderDump, type DumpFormat } from "./commands/ladder-dump.js";
import { ladderReplayCommits } from "./commands/ladder-replay-commits.js";
import { laneLog, type LaneLogFormat } from "./commands/lane-log.js";
import { work } from "./commands/work.js";
import { workAssist } from "./commands/workAssist.js";
import { top } from "./commands/top.js";
import { askPost } from "./commands/ask-post.js";
import { review } from "./commands/review.js";
import { login, whoami } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { agentCreate, agentToken, agentList, agentDelete } from "./commands/agent.js";
import { repoCreate, repoList, repoGrant, repoClone, repoDelete } from "./commands/repo.js";
import { repoSubmit } from "./commands/repo-submit.js";
import { repoPolicyShow, repoPolicySet } from "./commands/repo-policy.js";
import { askClaim } from "./commands/ask-claim.js";
import { askAnswer } from "./commands/ask-answer.js";
import { askList } from "./commands/ask-list.js";
import { voteTally } from "./commands/vote-tally.js";
import { whistleblowResolve } from "./commands/whistleblow.js";
import { laneProposeCmd } from "./commands/lane-propose.js";
import { laneGrantCmd } from "./commands/lane-grant.js";
import { ladderEdit } from "./commands/ladder-edit.js";
import { ladderPush } from "./commands/ladder-push.js";
import { ladderSync } from "./commands/ladder-sync.js";

registerLocalBackendFactory(createLocalBackend);

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
  .option("--provider <name>", "ollama (local, default), gemini, groq, or cloudflare -- same meaning as zz work --provider")
  .option("--model <name>", "model name for whichever provider -- see zz work --help for each provider's own default")
  .action(async (repo: string, opts: { force?: boolean; provider?: Provider; model?: string }) => {
    await ladderBuild(repo, { force: opts.force, provider: opts.provider, model: opts.model });
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
  .requiredOption("--kind <kind>", "repo, directory, file, release, changeset, ask, contributor, or dependencies -- a kind with no git object of its own (function, lines, package, filechange, linechange) can only be written nested inside its parent's children, which this command can't do; use ladder_write_rung directly for those")
  .requiredOption("--summary <text>", "what this rung describes, holistically -- not just what changed")
  .option("--commit <sha>", "anchor to this commit instead of the current directory's HEAD")
  .option("--as <name>", "write as a managed agent instead of yourself")
  .action(async (repo: string, path: string, opts: { kind: string; summary: string; commit?: string; as?: string }) => {
    await ladderEdit(repo, path, opts);
  });

ladder
  .command("push <local-repo> <owner/repo>")
  .description("one-time transfer of a locally-built Ladder (zz ladder build) onto a real remote repo: pushes the real git history, then replays every local rung via ladder_write_rung -- no model calls, no GitHub API calls, just reading back what zz ladder build already wrote")
  .action(async (localRepo: string, targetRepo: string) => {
    await ladderPush(localRepo, targetRepo);
  });

ladder
  .command("sync <local-repo> <owner/repo>")
  .description("keep an already-imported repo in sync with its real GitHub source: fetches the latest commits, re-summarizes only the files that actually changed, picks up any new issues/PRs/releases/contributors/dependencies, then pushes the result -- run `zz ladder push` at least once first")
  .option("--provider <name>", "ollama (local, default), gemini, groq, or cloudflare -- same meaning as zz work --provider")
  .option("--model <name>", "model name for whichever provider -- see zz work --help for each provider's own default")
  .action(async (localRepo: string, targetRepo: string, opts: { provider?: Provider; model?: string }) => {
    await ladderSync(localRepo, targetRepo, { provider: opts.provider, model: opts.model });
  });

const lane = program.command("lane").description("inspect the Lane/ASK/ANSWER protocol trail");

lane
  .command("log <repo>")
  .description("chronological log of every ASK/ANSWER across every Lane for a repo")
  .option("--format <format>", "text or json", "text")
  .option("--lane <id>", "show only one lane")
  .option("--out <path>", "write to a file instead of stdout")
  .option("--local", "read the original local/demo backend instead of the default: the deployed Worker's real protocol state")
  .option("--full", "don't truncate a payload's JSON at 80 chars in text format -- --format json always shows everything regardless")
  .option("--needs-triage", "only denials flagged needsTriage: true -- a changeset_review that hit its retry cap and stopped reposting, not an ordinary single-pass rejection")
  .action(async (repo: string, opts: { format: string; lane?: string; out?: string; local?: boolean; full?: boolean; needsTriage?: boolean }) => {
    const format = opts.format as LaneLogFormat;
    if (format !== "text" && format !== "json") {
      console.error(`unknown format "${opts.format}"; expected text or json`);
      process.exitCode = 1;
      return;
    }
    await laneLog(repo, { format, lane: opts.lane, out: opts.out, local: opts.local, full: opts.full, needsTriage: opts.needsTriage });
  });

lane
  .command("propose <repo> <name>")
  .description("propose a Lane by hand -- the one way to seat an explicit multi-member Committee (--committee); every other path defaults a new Lane's committee to just its proposer")
  .option("--objective <text>", "what this Lane is for (default: the name)")
  .option("--committee <ids>", "comma-separated agent ids -- defaults to just you if omitted")
  .option("--id <id>", "explicit lane id (default: a generated one)")
  .option("--as <name>", "propose as a managed agent instead of yourself")
  .action(async (repo: string, name: string, opts: { objective?: string; committee?: string; id?: string; as?: string }) => {
    await laneProposeCmd(repo, name, opts);
  });

lane
  .command("grant <repo> <lane-id> <principal> <role>")
  .description('add an agent to an EXISTING Lane\'s coordinators or committee -- role is "coordinator" or "committee". Needs to already be a coordinator of that Lane yourself; a repo-level Role grant (zz repo grant) has no effect on a Lane\'s own authority by itself')
  .option("--as <name>", "act as a managed agent instead of yourself")
  .action(async (repo: string, laneId: string, principal: string, role: string, opts: { as?: string }) => {
    await laneGrantCmd(repo, laneId, principal, role, opts);
  });

const askCmd = program.command("ask").description("post Asks into a Lane's queue by hand");

askCmd
  .command("post <repo> [lane]")
  .description('post an Ask into a Lane\'s queue -- e.g. --kind work --description "..." for the common case a zz work loop will pick up. Lane defaults to the origin Lane ("_repo") -- the one `zz repo ask` always posted to, before #43 retired it in favor of this one command. Local-only unless --remote.')
  .option("--kind <kind>", 'Ask kind (default: "work")')
  .option("--from <agent>", 'who it\'s from, local mode only (default: "human")')
  .option("--description <text>", 'shorthand for payload { description: text } -- what kind "work" expects')
  .option("--decompose", "with --description: mark this task to be split into several independent sub-tasks (each its own new Lane) instead of implemented directly -- picked up by `zz work`'s autonomous loop, not --assist")
  .option("--payload <json>", "raw JSON payload, for any other kind")
  .option("--priority <n>", "higher = more urgent at query time", (v) => parseInt(v, 10))
  .option("--remote", "post to a real hosted repo instead of the local backend -- needed for a kind with no dedicated REST endpoint (e.g. vote_request, whistleblow)")
  .option("--as <name>", "post as a managed agent instead of yourself, remote mode only")
  .action(async (repo: string, lane: string | undefined, opts: { kind?: string; from?: string; description?: string; decompose?: boolean; payload?: string; priority?: number; remote?: boolean; as?: string }) => {
    await askPost(repo, lane ?? ORIGIN_LANE_ID, opts);
  });

askCmd
  .command("list <owner/repo> [lane]")
  .description('show a Lane\'s full history (every ASK/ANSWER/INSIGHT posted so far) -- lane defaults to the origin Lane ("_repo"). Replaces the now-retired `zz repo asks`, which only ever showed the origin Lane.')
  .action(async (slug: string, lane?: string) => {
    await askList(slug, lane);
  });

askCmd
  .command("claim <repo> <ask-id>")
  .description("claim an Ask by hand and open a new Lane for the work (prints its id) -- the manual-CLI counterpart to an agent's own claim step")
  .option("--lane <id>", 'which Lane the ask lives in (default: the origin Lane, "_repo")')
  .option("--as <name>", "claim as a managed agent instead of yourself")
  .action(async (repo: string, askId: string, opts: { lane?: string; as?: string }) => {
    await askClaim(repo, askId, opts);
  });

askCmd
  .command("answer <repo> <ask-id> <action>")
  .description('answer an Ask by hand -- action is "complete", "deny", "veto" (a changeset_review only, sets the Lane "vetoed"), or "vote" (a vote_request only, payload { ballot: "+1"|"+0"|"-0"|"-1" })')
  .option("--lane <id>", 'which Lane the ask lives in (default: the origin Lane, "_repo")')
  .option("--as <name>", "answer as a managed agent instead of yourself")
  .option("--payload <json>", "raw JSON payload -- a veto's reason, a vote's ballot, a complete's result, etc.")
  .action(async (repo: string, askId: string, action: string, opts: { lane?: string; as?: string; payload?: string }) => {
    await askAnswer(repo, askId, action, opts);
  });

askCmd
  .command("vote-tally <repo> <ask-id>")
  .description("count ballots on a vote_request and close it once every committee member has voted (and, if approved and it was a Policy change, apply it)")
  .option("--lane <id>", 'which Lane the ask lives in (default: the origin Lane, "_repo")')
  .option("--as <name>", "act as a managed agent instead of yourself")
  .action(async (repo: string, askId: string, opts: { lane?: string; as?: string }) => {
    await voteTally(repo, askId, opts);
  });

askCmd
  .command("whistleblow <repo> <ask-id>")
  .description("close a whistleblow Ask and run the incident runbook: STOP this Lane, DROP the reported Agent's other pending Asks in it, and ROLL back --target-commit if given")
  .requiredOption("--target-agent <id>", "the Agent the report is about")
  .requiredOption("--reason <text>", "why")
  .option("--target-commit <sha>", "an already-merged commit to revert, if any")
  .option("--lane <id>", 'which Lane the ask lives in (default: the origin Lane, "_repo")')
  .option("--as <name>", "act as a managed agent instead of yourself (must be this Lane's coordinator)")
  .action(async (repo: string, askId: string, opts: { lane?: string; as?: string; targetAgent: string; targetCommit?: string; reason: string }) => {
    await whistleblowResolve(repo, askId, opts);
  });

program
  .command("work [repo]")
  .description("headless work loop: continuously claims and works whatever Asks your identity is permitted to act on. [repo] is shorthand for --repos <repo> (a single owner/repo); omit both to use ~/.zz/config.json's list. For a headless run with no `zz login` session at all, set ZZ_ID=\"<username>:<token>\" (or ZZ_ID_FILE=<path to a file with that same text>) instead of --as/--agent.")
  .option("--as <name>", 'act as a managed agent instead of yourself, e.g. "--as claude" -- expands to "<your username>[claude]", using the token `zz agent create`/`zz agent token` already saved locally for it (see `zz agent --help`). Omit to act as yourself (your own `zz login` session).')
  .option("--agent <id>", "your agent identity by its exact username (default: --as, else your own login, else ~/.zz/config.json) -- --as is the normal way to do this, this stays mainly for the --local path")
  .option("--repos <list>", "comma-separated owner/repo list (default: from ~/.zz/config.json) -- ignored if [repo] is given", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .option("--scope <scope>", "coordinator, contributor, committee (merge and voting, never open-scope work), or all (default: all)", "all")
  .option("--stdio", "one flat combined log stream instead of the live TUI")
  .option("--max-turns <n>", "stop a single claimed Ask after this many tool-calling turns (default: 60)", (v) => parseInt(v, 10))
  .option("--poll-ms <n>", "how often to recheck for claimable work when idle (default: 1000)", (v) => parseInt(v, 10))
  .option("--no-wait", "exit once nothing is claimable, instead of idling and rechecking forever -- for a one-off/scripted run rather than a long-lived worker. Ignored with --assist, or if --ask is given.")
  .option("--ask <id>", "work this one specific ask (any kind/scope) and exit, regardless of what else is claimable afterward -- for a one-off command-line step where there's exactly one known ask to act on. Ignored with --assist.")
  .option("--provider <name>", "ollama (local, default), gemini, groq, or cloudflare (remote, each needs its own API key -- see app/.env)")
  .option("--model <name>", 'model name for whichever provider -- default is "qwen2.5:14b-instruct" (ollama), "gemini-3.8-flash" (gemini), "openai/gpt-oss-120b" (groq), or "@cf/meta/llama-3.3-70b-instruct-fp8-fast" (cloudflare). Run `zz models` to see what\'s available locally for ollama.')
  .option("--local", "use the original local/demo backend (a real local clone, state in .zz/) instead of the default: your resolved identity's real protocol state on the deployed Worker")
  .option(
    "--assist",
    "a human-in-the-loop TUI instead of the headless loop: pick a claimable work/changeset_review ask from the repos you're watching (same resolution as `zz top`), chat with the model about its draft/recommendation, then explicitly submit it back as a real ANSWER. Never clones anything until you've picked an ask. Ignores --stdio/--poll-ms/--max-turns.",
  )
  .action(async (repo: string | undefined, opts: { as?: string; agent?: string; repos?: string[]; scope?: string; stdio?: boolean; maxTurns?: number; pollMs?: number; model?: string; provider?: string; local?: boolean; assist?: boolean; wait: boolean; ask?: string }) => {
    // Commander's --no-<x> convention: this option surfaces as `wait`,
    // defaulting true, false only when --no-wait was actually passed --
    // never a `noWait` field despite the flag's own spelling.
    const noWait = opts.wait === false;
    if (opts.scope && !["coordinator", "contributor", "committee", "all"].includes(opts.scope)) {
      console.error(`unknown --scope "${opts.scope}"; expected coordinator, contributor, committee, or all`);
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
        scope: opts.scope as "coordinator" | "contributor" | "committee" | "all" | undefined,
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
      scope: opts.scope as "coordinator" | "contributor" | "committee" | "all" | undefined,
      stdio: opts.stdio,
      maxTurns: opts.maxTurns,
      pollMs: opts.pollMs,
      model: opts.model,
      provider: opts.provider as "ollama" | "gemini" | "groq" | "cloudflare" | undefined,
      local: opts.local,
      noWait,
      askId: opts.ask,
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
  .option("--ask <id>", "review this one changeset_review and exit, instead of waiting for new ones -- for a one-off command-line step (e.g. a demo script) rather than a human sitting at a terminal watching for whatever comes next")
  .option("--no-wait", "review everything currently claimable, same prompt as the default loop, then exit once the queue is empty -- for draining a whole batch in one sitting without knowing every ask's id the way --ask requires. Ignored if --ask is given.")
  .action(async (repo: string | undefined, opts: { as?: string; agent?: string; repos?: string[]; local?: boolean; ask?: string; wait: boolean }) => {
    // Commander's --no-<x> convention: surfaces as `wait` (default true), not `noWait`.
    await review({ as: opts.as, agent: opts.agent, repos: repo ? [repo] : opts.repos, local: opts.local, askId: opts.ask, noWait: opts.wait === false });
  });

program
  .command("login")
  .description("log in to the remote (Cloudflare) backend -- opens a browser, waits for you to finish, saves a token to ~/.zz/credentials.json. Same identity model either way: a human login and an agent's bearer token are both just an Agent's credential.")
  .option("--api-base <url>", "override the Worker URL (default: ~/.zz/credentials.json's, or the built-in default)")
  .option("--whoami", "print the currently logged-in account and exit, without starting a new login")
  .action(async (opts: { apiBase?: string; whoami?: boolean }) => {
    if (opts.whoami) {
      whoami();
      return;
    }
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

agentCmd
  .command("delete <username>")
  .description("permanently delete a managed agent you created -- its tokens, login identities, and sessions. Refuses if it still owns a repo, holds a Role grant, or created an agent that still exists")
  .option("-y, --yes", "skip the type-the-username-to-confirm prompt")
  .action(async (username: string, opts: { yes?: boolean }) => {
    await agentDelete(username, { yes: opts.yes });
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
  .description("grant an Agent (by username, e.g. thoward37@gmail.com[claude]) a repo Role -- owner, coordinator, contributor, or viewer. Needs Owner on the repo yourself.")
  .action(async (slug: string, principal: string, role: string) => {
    await repoGrant(slug, principal, role);
  });

repoCmd
  .command("clone <owner/repo> [dir]")
  .description("git clone a repo with your zz login token embedded automatically -- no need to paste it into a username/password prompt by hand")
  .action(async (slug: string, dir?: string) => {
    await repoClone(slug, dir);
  });

repoCmd
  .command("delete <owner/repo>")
  .description("permanently delete a repo -- real git history, Ladder, Lanes, all of it. Needs Owner on the repo yourself.")
  .option("-y, --yes", "skip the type-the-slug-to-confirm prompt")
  .action(async (slug: string, opts: { yes?: boolean }) => {
    await repoDelete(slug, { yes: opts.yes });
  });

const repoPolicyCmd = repoCmd.command("policy").description("read or change a repo's Policy -- what it takes to merge a change, and to change Policy itself");

repoPolicyCmd
  .command("show <owner/repo>")
  .description("print the repo's current Policy document (\"policy_change\", \"policies\", \"claim_mode\", \"retention\", and \"conflict_policies\")")
  .action(async (slug: string) => {
    await repoPolicyShow(slug);
  });

repoPolicyCmd
  .command("set <owner/repo>")
  .description(
    'change Policy directly -- only works for an Owner, or for anyone Coordinator+ when whatever\'s being changed is itself under a "direct" rule; anything stricter refuses and tells you to post a changeset_review/vote_request instead',
  )
  .option("--repo-rule <mode>", 'sets "policy_change" (the rule for changing Policy itself) -- direct, self_review, other_approver, vote_quorum, or vote_expiring')
  .option("--path <glob>", "with --mode: upserts one \"policies\" entry for this path glob")
  .option("--mode <mode>", "the mode for --path -- direct, self_review, other_approver, vote_quorum, or vote_expiring")
  .option("--expiry-hours <n>", "vote_expiring only -- how long the vote stays open before lazy consensus can close it (default: 72)")
  .option("--claim-mode-manual <mode>", 'with --claim-mode-autonomous: sets "claim_mode" -- which claim path `zz ask claim` takes -- "in_place" or "shard"')
  .option("--claim-mode-autonomous <mode>", 'with --claim-mode-manual: sets "claim_mode" -- which claim path the autonomous work loop takes -- "in_place" or "shard"')
  .option("--retention-mode <mode>", 'sets "retention" -- what happens to a completed work Lane\'s own shard once it goes terminal -- "keep" (default), "dispose" (DESTRUCTIVE: deletes it immediately), or "ttl" (schema only, not yet enforced -- behaves like "keep" today)')
  .option("--retention-ttl-hours <n>", "ttl only -- hours after the Lane goes terminal before disposal (not yet enforced)")
  .option("--conflict-path <glob>", "with --conflict-mode: upserts one \"conflict_policies\" entry for this path glob -- what happens when two changes collide, independent of --path/--mode (which govern approving a clean change)")
  .option("--conflict-mode <mode>", "the mode for --conflict-path -- first_wins (default)/coordinator_decides/vote/escalate_human/mediate, all implemented")
  .option("--as <name>", 'act as a managed agent instead of yourself, e.g. "--as claude" -- see `zz work --help`')
  .action(
    async (
      slug: string,
      opts: {
        repoRule?: string;
        path?: string;
        mode?: string;
        expiryHours?: string;
        claimModeManual?: string;
        claimModeAutonomous?: string;
        retentionMode?: string;
        retentionTtlHours?: string;
        conflictPath?: string;
        conflictMode?: string;
        as?: string;
      },
    ) => {
      await repoPolicySet(slug, opts);
    },
  );

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
  // Node's own fetch() wraps every network-level failure (DNS, a reset
  // connection, a dropped TLS handshake, ...) in a TypeError whose own
  // .message is always just the literal string "fetch failed" -- the
  // actual cause lives one level down, in .cause, which this handler
  // silently dropped before. Confirmed live: a real "zz: fetch failed"
  // with no .cause printed gave no way to tell a transient network
  // hiccup apart from, say, two concurrent `zz work` processes racing
  // on something.
  if (err instanceof Error && err.cause) {
    console.error(`caused by: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`);
  }
  process.exitCode = 1;
});
