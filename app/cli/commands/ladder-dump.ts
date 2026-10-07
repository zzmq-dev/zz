// `zz ladder dump <owner/repo> [--format text|json|html] [--out <path>]`:
// materializes a Ladder already written to git notes into something
// readable, without touching the notes themselves.
import { writeFileSync } from "node:fs";
import { resolveRepo } from "../lib/repo.js";
import { collectLadder, renderText } from "../../engine/ladderRender.js";
import { renderHtml } from "../render/html.js";

export type DumpFormat = "text" | "json" | "html";

export interface DumpOptions {
  format?: DumpFormat;
  out?: string;
}

export async function ladderDump(slug: string, options: DumpOptions): Promise<void> {
  const repo = resolveRepo(slug);
  const format = options.format ?? "text";
  const { tree, stats } = await collectLadder(repo.repoDir, repo.stateDir);

  let output: string;
  if (format === "json") {
    output = JSON.stringify({ repo: repo.slug, generatedAt: new Date().toISOString(), stats, tree }, null, 2);
  } else if (format === "html") {
    output = renderHtml(tree, { repoSlug: repo.slug, generatedAt: new Date().toISOString(), stats });
  } else {
    output = renderText(tree);
  }

  if (options.out) {
    writeFileSync(options.out, output);
    console.error(`wrote ${stats.rungs} rungs (${stats.notes} notes read) to ${options.out}`);
  } else {
    process.stdout.write(output + "\n");
  }
}
