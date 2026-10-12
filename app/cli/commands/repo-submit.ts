// `zz repo submit <owner/repo> <lane-id> <ask-id>`: the human-contributor
// counterpart to agent/scriptedWork.ts's runContributorWorkAsk -- posts
// a changeset_review + a dependent submit_changeset ask, then completes
// the work ask, exactly the same protocol sequence an LLM-driven agent
// follows via commit_changeset/ask_post/ask_answer, just reading real
// file content off disk (what you `git add`ed) instead of generating
// it. No local clone convention assumed: run this from inside whatever
// directory `zz repo clone` (or a plain `git clone` with your own
// token) put the repo in -- it operates on the current working
// directory's git index, same as any other git-adjacent CLI command.
//
// This does NOT commit anything itself -- posting a changeset_review
// only proposes one. A Maintainer still has to `zz review` and approve
// it before a coordinator's `zz work` run actually merges it (calls
// commit_changeset for real). That two-step is the point: a raw push
// bypasses per-changeset review entirely, which is exactly what this
// path exists to go through instead.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { requireCredentials } from "../lib/credentials.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { AskEntry, Lane } from "../../engine/types.js";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export interface RepoSubmitOptions {
  message?: string;
}

export async function repoSubmit(slug: string, laneId: string, askId: string, opts: RepoSubmitOptions): Promise<void> {
  const creds = requireCredentials();

  const staged = git(["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
  if (staged.length === 0) {
    console.error("Nothing staged. Edit your files, `git add` the ones you changed, then run this again.");
    process.exitCode = 1;
    return;
  }

  const files = staged.map((path) => ({ path, content: readFileSync(path, "utf8") }));
  const baseCommit = git(["rev-parse", "HEAD"]);
  const message = opts.message ?? `Changes to ${staged.join(", ")}`;

  const lane = (await callRemoteTool(slug, "lane_get", { lane_id: laneId })) as Lane | null;
  if (!lane) throw new Error(`no such lane "${laneId}" in ${slug}`);
  const theAsk = lane.history.find((e): e is AskEntry => e.type === "ASK" && e.id === askId);
  if (!theAsk) throw new Error(`no such ask "${askId}" in ${slug}/${laneId}`);
  const taskDescription = (theAsk.payload as { description?: string } | undefined)?.description ?? JSON.stringify(theAsk.payload);

  const review = (await callRemoteTool(slug, "ask_post", {
    lane_id: laneId,
    kind: "changeset_review",
    from: creds.username,
    payload: { taskDescription, files, message, summary: message },
    depends_on: [],
  })) as AskEntry;

  await callRemoteTool(slug, "ask_post", {
    lane_id: laneId,
    kind: "submit_changeset",
    from: creds.username,
    payload: { files, message, summary: message, baseCommit },
    depends_on: [askId, review.id],
  });

  await callRemoteTool(slug, "ask_answer", {
    lane_id: laneId,
    ask_id: askId,
    actor: creds.username,
    action: "complete",
    payload: { summary: message },
  });

  console.log(`Submitted ${staged.length} file(s) for review (changeset_review ${review.id}) and marked ${askId} complete.`);
  console.log(`Next: a Maintainer needs to \`zz review\` and approve it; once granted, a coordinator's \`zz work\` run merges it for real.`);
}
