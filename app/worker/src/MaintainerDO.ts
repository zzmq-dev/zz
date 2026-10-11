// One Durable Object instance per repo -- the Lane/Ask/Answer side of
// the Maintainer DO (site/content/remote-backend/index.md). Deliberately
// thin: it reuses engine/lane.ts's real ask()/answer()/proposeLane()
// verbatim, scoped to this instance's own storage via
// engine/backend.ts's withBackend() (AsyncLocalStorage), rather than
// reimplementing any protocol logic here. That's the whole point of
// step 1's refactor -- the RBAC checks, the changeset_review gate, the
// embedded-files guard, all of engine/lane.ts's real behavior runs
// unchanged, just against a different storage underneath.
import { DurableObject } from "cloudflare:workers";
import { withBackend } from "../../engine/backend.js";
import { ask, answer, proposeLane } from "../../engine/lane.js";
import { createDoLaneBackend } from "./doLaneBackend.js";
import { commitChangesetOnArtifacts, readFileAtCommit, type ArtifactsNamespace } from "./cloudflareGitBackend.js";
import type { ChangesetFile, CommitAuthor } from "../../engine/changeset.js";
import type { AskEntry, AskKind, Lane, LaneRef } from "../../engine/types.js";

interface Env {
  ARTIFACTS: ArtifactsNamespace;
}

export class MaintainerDO extends DurableObject<Env> {
  private backend = createDoLaneBackend(this.ctx.storage);
  // This DO's own identity doubles as the "repo" key engine/lane.ts's
  // functions expect -- irrelevant to doLaneBackend (one DO instance
  // already is one repo's storage) but kept consistent with the real
  // Backend interface shape.
  private repo = "do";

  async proposeLane(input: { id: string; repo: string; name: string; objective: string; scope: string[]; proposedBy: string; origin?: LaneRef | null; coordinators?: string[]; maintainers?: string[] }): Promise<Lane> {
    return withBackend(this.backend, () => proposeLane(this.repo, input));
  }

  async ask(laneId: string, input: { kind: AskKind; from: string; payload?: unknown; depends_on?: string[]; priority?: number }): Promise<AskEntry> {
    return withBackend(this.backend, () => ask(this.repo, laneId, input));
  }

  async answer(laneId: string, theAsk: AskEntry, input: { from: string; action: "grant" | "deny" | "complete"; payload?: unknown }) {
    return withBackend(this.backend, () => answer(this.repo, laneId, theAsk, input));
  }

  async readLane(laneId: string): Promise<Lane | null> {
    return withBackend(this.backend, () => this.backend.readLane(this.repo, laneId));
  }

  async listLanes(): Promise<Lane[]> {
    return withBackend(this.backend, () => this.backend.listLanes(this.repo));
  }

  // Git content: not yet folded into `this.backend` as a full Backend
  // (the Ladder/notes side isn't built yet -- see cloudflareGitBackend.ts's
  // header), so these are called directly rather than through
  // engine/lane.ts. `artifactsName`/`remote` are passed explicitly by
  // the caller (it already has them from creating/looking up the
  // repo) rather than this DO tracking its own Artifacts identity.
  async commitChangeset(artifactsName: string, remote: string, input: { files: ChangesetFile[]; message: string; author: CommitAuthor }): Promise<string> {
    const repo = await this.env.ARTIFACTS.get(artifactsName);
    const token = await repo.createToken("write", 3600);
    try {
      return await commitChangesetOnArtifacts(artifactsName, remote, token, repo, input);
    } finally {
      repo[Symbol.dispose]?.();
    }
  }

  async readFileAtCommit(artifactsName: string, commitHash: string, path: string): Promise<string> {
    const repo = await this.env.ARTIFACTS.get(artifactsName);
    try {
      return await readFileAtCommit(repo, commitHash, path);
    } finally {
      repo[Symbol.dispose]?.();
    }
  }
}
