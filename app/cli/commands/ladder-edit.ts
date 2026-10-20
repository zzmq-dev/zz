// `zz ladder edit <owner/repo> <path>`: writes one Ladder rung by hand
// -- the human-contributor counterpart to a model's own
// `ladder_write_rung` call in agent/scriptedWork.ts. Anchors to a real
// commit (defaulting to the current directory's HEAD), same cwd-git
// convention cli/commands/repo-submit.ts already uses, since
// repo/file/changeset/release kinds all require a real commit source
// to anchor their note to (agent/tools.ts's validateAnchorSources).
// One rung per call, not a batch -- the demo narrates writing the
// repo rung, then each file rung, as separate, visible steps.
import { execFileSync } from "node:child_process";
import { resolveIdentity, releaseIdentity } from "../lib/identity.js";
import { resolveMe } from "../lib/credentials.js";
import { setActiveToken } from "../lib/api.js";
import { callRemoteTool } from "../lib/remoteTools.js";
import type { RungKind, RungSource } from "../../engine/ladder.js";

export interface LadderEditOptions {
  kind: string;
  summary: string;
  /** Defaults to the current directory's HEAD. */
  commit?: string;
  /** --as <name>: write as a managed agent instead of yourself. */
  as?: string;
}

function commitSource(sha?: string): RungSource {
  const ref = sha ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const [title, author, at] = execFileSync("git", ["log", "-1", "--format=%s%x1f%an%x1f%aI", ref], { encoding: "utf8" }).trim().split("\x1f");
  return { kind: "commit", ref, title, author, at };
}

export async function ladderEdit(slug: string, path: string, opts: LadderEditOptions): Promise<void> {
  slug = resolveMe(slug);
  const identity = await resolveIdentity({ as: opts.as });
  setActiveToken(identity.token);

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await releaseIdentity(identity);
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));

  try {
    const rung = {
      path,
      kind: opts.kind as RungKind,
      summary: opts.summary,
      sources: [commitSource(opts.commit)],
      children: [],
    };
    await callRemoteTool(slug, "ladder_write_rung", { rung });
    console.log(`Wrote the "${path}" (${opts.kind}) rung on ${slug}.`);
  } finally {
    await cleanup();
  }
}
