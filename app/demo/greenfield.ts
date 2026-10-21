// Driving real, forward-going development through the actual zz
// protocol -- scenario 1 of the greenfield test (me as the developer).
// Every increment: propose a Lane, claim it, submit a changeset (real
// file content as the ask's payload, committed via engine/changeset.ts
// with no working-tree file ever written), then merge the real Ladder
// content describing what just landed. No shortcuts around the
// protocol -- this is the same claim/submit/merge shape ladder-build.ts
// and ladder-replay-commits.ts already use, just authoring new content
// instead of describing history.
import { ensureCloned, resolveRepo } from "../cli/lib/repo.js";
import { registerLocalBackendFactory } from "../engine/backend.js";
import { createLocalBackend } from "../engine/localBackend.js";
import { ask, answer, mergeLaneLadder, proposeLane, ORIGIN_LANE_ID } from "../engine/lane.js";

registerLocalBackendFactory(createLocalBackend);
import { commitChangeset, type ChangesetFile } from "../engine/changeset.js";
import { readAnchor, writeLadder } from "../engine/ladderNotes.js";
import { readLane } from "../engine/store.js";
import type { Rung } from "../engine/ladder.js";
import { REPO_RUNG_PATH } from "../engine/ladder.js";
import type { LaneRef } from "../engine/types.js";

export const AUTHOR = { name: "zz-dev", email: "zz-dev@local" };
const COORDINATOR = "zz-coordinator";

export async function ensureRepoLane(slug: string) {
  const repo = resolveRepo(slug);
  ensureCloned(repo);
  // ORIGIN_LANE_ID, not REPO_RUNG_PATH -- see webApp.ts's doCreateRepo
  // for the same latent bug, found the same way.
  let repoLane = readLane(repo.stateDir, ORIGIN_LANE_ID);
  if (!repoLane) {
    repoLane = await proposeLane(repo.slug, { id: ORIGIN_LANE_ID, repo: slug, name: slug, objective: `the ${slug} repository`, scope: ["**"], proposedBy: COORDINATOR, coordinators: [COORDINATOR] });
    const review = await ask(repo.slug, repoLane.id, { kind: "review_request", from: COORDINATOR });
    await answer(repo.slug, repoLane.id, review, { from: COORDINATOR, action: "grant" });
  }
  return { repo, repoLane };
}

export interface IncrementInput {
  laneId: string;
  name: string;
  objective: string;
  scope: string[];
  files: ChangesetFile[];
  message: string;
  /** Top-level rungs to land in the Ladder, built from the real commit oid (sources need the real sha). */
  buildLadderRungs: (commitOid: string) => Rung[];
  /** Overrides the default origin (this repo's own _repo Lane) -- set this to a Lane in a different repo when the work exists because of that upstream Lane, a real cross-repo dependency, not just this repo's own history. */
  origin?: LaneRef;
}

export async function submitIncrement(slug: string, input: IncrementInput): Promise<{ commitOid: string }> {
  const { repo, repoLane } = await ensureRepoLane(slug);
  const origin: LaneRef = input.origin ?? { repo: slug, lane: repoLane.id };

  const lane = await proposeLane(repo.slug, {
    id: input.laneId,
    repo: slug,
    name: input.name,
    objective: input.objective,
    scope: input.scope,
    origin,
    proposedBy: AUTHOR.name,
    coordinators: [AUTHOR.name],
  });

  const claim = await ask(repo.slug, lane.id, { kind: "claim_request", from: AUTHOR.name });
  await answer(repo.slug, lane.id, claim, { from: AUTHOR.name, action: "grant" });

  const submit = await ask(repo.slug, lane.id, { kind: "submit_changeset", from: AUTHOR.name, payload: { files: input.files, message: input.message } });
  const commitOid = await commitChangeset(repo.repoDir, { files: input.files, message: input.message, author: AUTHOR });
  await answer(repo.slug, lane.id, submit, { from: AUTHOR.name, action: "grant", payload: { commit: commitOid } });

  const rungs = input.buildLadderRungs(commitOid);
  const mergeRequest = await ask(repo.slug, lane.id, { kind: "merge_request", from: AUTHOR.name, payload: { ladder: rungs.map((r) => ({ path: r.path, kind: r.kind })) } });

  // _repo's own note doesn't exist until after the repo's first real
  // commit (it anchors to the root tree); writing it for the first
  // time means wrapping the new rungs as its children directly, the
  // same bootstrap ladder-build.ts does, rather than calling
  // appendRepoChildren on a note that doesn't exist yet.
  const repoAnchor = await readAnchor(repo.repoDir, repo.stateDir, REPO_RUNG_PATH);
  if (!repoAnchor) {
    const root: Rung = { path: REPO_RUNG_PATH, kind: "repo", summary: `${slug}, built from scratch through the zz protocol.`, sources: [], children: rungs };
    await writeLadder(repo.repoDir, repo.stateDir, root);
  } else {
    await mergeLaneLadder(repo.slug, rungs);
  }
  await answer(repo.slug, lane.id, mergeRequest, { from: AUTHOR.name, action: "grant" });

  return { commitOid };
}
