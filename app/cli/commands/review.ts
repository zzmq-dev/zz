// `zz review`: the minimal slice of what was deferred as "zz cowork"
// this session -- a human claiming and answering changeset_review asks
// specifically (the Maintainer judgment call policy requires, see
// site/content/governance/index.md), with the mechanical protocol bits
// (claim, grant/deny) handled for them rather than hand-typed. Not a
// general interactive session manager: just this one HITL-critical
// step, since that's the concrete need, not the general one.
import { createInterface } from "node:readline/promises";
import { readConfig } from "../lib/config.js";
import { resolveRepo, ensureCloned, type ResolvedRepo } from "../lib/repo.js";
import { claimableAcrossRepos } from "../../engine/workqueue.js";
import { ask, answer } from "../../engine/lane.js";
import { resolveBackend } from "../../engine/backend.js";
import type { AskEntry } from "../../engine/types.js";

export interface ReviewOptions {
  agent?: string;
  repos?: string[];
  pollMs?: number;
}

interface ChangesetReviewPayload {
  taskDescription: string;
  files: { path: string; content: string }[];
  message: string;
  summary: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printReview(resolved: ResolvedRepo, laneId: string, theAsk: AskEntry): void {
  const payload = theAsk.payload as ChangesetReviewPayload;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`changeset_review ${theAsk.id} -- ${resolved.slug}/${laneId}`);
  console.log(`${"=".repeat(72)}`);
  console.log(`Task:    ${payload.taskDescription}`);
  console.log(`Message: ${payload.message}`);
  console.log(`Summary: ${payload.summary}`);
  for (const f of payload.files) {
    console.log(`\n--- ${f.path} ---`);
    console.log(f.content);
  }
  console.log(`${"=".repeat(72)}`);
}

export async function review(options: ReviewOptions): Promise<void> {
  const config = readConfig({ agent: options.agent, repos: options.repos });
  const resolvedRepos = config.repos.map((slug) => resolveRepo(slug));
  for (const r of resolvedRepos) ensureCloned(r);

  const pollMs = options.pollMs ?? 1000;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`zz review: agent="${config.agent}" repos=${config.repos.join(", ")} -- watching for changeset_review asks you can approve`);

  try {
    for (;;) {
      const claimable = (
        await claimableAcrossRepos(
          resolvedRepos.map((r) => ({ repo: r.slug })),
          config.agent,
        )
      ).filter((c) => c.ask.kind === "changeset_review");

      if (claimable.length === 0) {
        await sleep(pollMs);
        continue;
      }

      const next = claimable[0];
      const resolved = resolvedRepos.find((r) => r.slug === next.repo)!;
      printReview(resolved, next.laneId, next.ask);

      const choice = (await rl.question("approve (a) / request changes (r) / skip (s)? ")).trim().toLowerCase();
      if (choice === "s") continue;

      if (!next.alreadyClaimed) {
        const claim = await ask(resolved.slug, next.laneId, { kind: "claim_request", from: config.agent, payload: { target: next.ask.id } });
        const lane = await resolveBackend().readLane(resolved.slug, next.laneId);
        await answer(resolved.slug, next.laneId, claim, { from: lane?.maintainers[0] ?? config.agent, action: "grant", payload: { grant: `grant-${claim.id}` } });
      }

      if (choice === "a") {
        await answer(resolved.slug, next.laneId, next.ask, { from: config.agent, action: "grant", payload: { reason: "approved by human review" } });
        console.log(`approved ${next.ask.id}`);
      } else {
        const reason = await rl.question("reason: ");
        await answer(resolved.slug, next.laneId, next.ask, { from: config.agent, action: "deny", payload: { reason } });
        console.log(`requested changes on ${next.ask.id}: ${reason}`);
      }
    }
  } finally {
    rl.close();
  }
}
