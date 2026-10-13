// One Durable Object instance per repo -- the Maintainer DO
// (site/content/remote-backend/index.md), now backed by the real,
// unified CloudflareBackend (cloudflareBackend.ts) rather than three
// separate pieces. Deliberately thin itself: it reuses
// agent/tools.ts's real ToolDef.execute() functions verbatim via
// callTool, scoped to this instance's own storage/Artifacts repo via
// engine/backend.ts's withBackend() (AsyncLocalStorage) -- the same
// reason step 3's design note gave, now extended to the whole tool
// surface, not just ask()/answer()/proposeLane(). Every RBAC check,
// the changeset_review gate, the embedded-files guard, run unchanged;
// this file has no protocol logic of its own.
import { DurableObject } from "cloudflare:workers";
import { withBackend } from "../../engine/backend.js";
import { ALL_TOOLS } from "../../agent/tools.js";
import { createCloudflareBackend } from "./cloudflareBackend.js";
import type { ArtifactsNamespace } from "./cloudflareGitBackend.js";

interface Env {
  ARTIFACTS: ArtifactsNamespace;
  DB: D1Database;
}

// Tools that fundamentally can't run in a Worker -- no child_process,
// no real git worktrees, no `gh` CLI -- never dispatched here even by
// name. Listed explicitly so calling one by name fails with a clear
// reason instead of a confusing downstream crash.
const WORKER_INCOMPATIBLE_TOOLS = new Set(["run_in_sandbox", "gh_fetch_issues", "gh_fetch_pull_requests", "gh_fetch_releases", "gh_fetch_contributors", "gh_fetch_thread_comments"]);

export class MaintainerDO extends DurableObject<Env> {
  // This DO's identity doubles as the Backend's "repo" key -- one DO
  // instance already is one repo's storage, so every tool call below
  // is scoped to it regardless of whatever `repo` string a caller
  // passes in its args (kept for shape-compatibility with
  // agent/tools.ts's parameters, not actually branched on).
  private artifactsName = "do";
  private backend = createCloudflareBackend(this.ctx.storage, this.env.ARTIFACTS, this.artifactsName, this.env.DB);

  /** Which Artifacts repo this DO instance actually operates on -- set once, before any tool call, since the DO's own id (from idFromName) doesn't reverse back to the name that created it.
   *
   * No-op when already configured for this same repo -- confirmed live: handleApiCallTool (every CLI/TUI tool call) calls this on EVERY single HTTP request, so rebuilding the Backend unconditionally threw away cloudflareBackend.ts's notesCache on every call, defeating it entirely for any multi-call sequence that crosses HTTP requests (e.g. the TUI resolving a Ladder tree one ladder_read per HTTP call -- 6 calls, 6 fresh checkouts of ref content 3 of those calls share). webApp.ts's own internal getLadderTree never hit this since it configures once then calls multiple times in-process; CLI/TUI calls, one HTTP request per tool call, always did. Staying configured for the same repo across calls means the cache (and cachedRootCommitOid, already durable-stored) actually survives for this DO instance's warm lifetime, not just one call -- a bounded, self-healing staleness window (any cold start/eviction clears it), same tradeoff already accepted for the durable root-oid cache. */
  async configure(artifactsName: string): Promise<void> {
    if (this.artifactsName === artifactsName) return;
    this.artifactsName = artifactsName;
    this.backend = createCloudflareBackend(this.ctx.storage, this.env.ARTIFACTS, artifactsName, this.env.DB);
  }

  /** The tool surface, by name -- the same ToolDef.execute() contract agent/tools.ts already defines, just reached over RPC instead of an in-process call. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (WORKER_INCOMPATIBLE_TOOLS.has(name)) {
      throw new Error(`"${name}" can't run on a Worker (no child_process, no real git worktrees, no \`gh\` CLI there) -- it's a local-only tool.`);
    }
    const tool = ALL_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return withBackend(this.backend, () => tool.execute(args));
  }
}
