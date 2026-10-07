#!/usr/bin/env node
import { Command } from "commander";
import { ladderBuild } from "./commands/ladder-build.js";
import { ladderDump, type DumpFormat } from "./commands/ladder-dump.js";

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

program.parseAsync(process.argv);
