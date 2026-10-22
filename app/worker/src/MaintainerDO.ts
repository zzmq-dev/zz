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
import type { Lane } from "../../engine/types.js";

// The three tool names that can change a Lane's own cached fields
// (name/objective/status/origin never change after lane_propose; the
// role lists can change again later via lane_grant/lane_revoke, or
// directly via seedOriginLaneRolesIfUnset below). lane_get/lane_list
// are reads; lane_add_related only touches the PARENT's related_lanes
// array, never this Lane's own cached fields, so it's not here.
const LANE_SYNCING_TOOLS = new Set(["lane_propose", "lane_grant", "lane_revoke"]);

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
  private backend = createCloudflareBackend(this.ctx.storage, this.env.ARTIFACTS, this.artifactsName, this.env.DB, (p) => this.ctx.waitUntil(p));

  /** Which Artifacts repo this DO instance actually operates on -- set once, before any tool call, since the DO's own id (from idFromName) doesn't reverse back to the name that created it.
   *
   * No-op when already configured for this same repo -- confirmed live: handleApiCallTool (every CLI/TUI tool call) calls this on EVERY single HTTP request, so rebuilding the Backend unconditionally threw away cloudflareBackend.ts's notesCache on every call, defeating it entirely for any multi-call sequence that crosses HTTP requests (e.g. the TUI resolving a Ladder tree one ladder_read per HTTP call -- 6 calls, 6 fresh checkouts of ref content 3 of those calls share). webApp.ts's own internal getLadderTree never hit this since it configures once then calls multiple times in-process; CLI/TUI calls, one HTTP request per tool call, always did. Staying configured for the same repo across calls means the cache (and cachedRootCommitOid, already durable-stored) actually survives for this DO instance's warm lifetime, not just one call -- a bounded, self-healing staleness window (any cold start/eviction clears it), same tradeoff already accepted for the durable root-oid cache. */
  async configure(artifactsName: string): Promise<void> {
    if (this.artifactsName === artifactsName) return;
    this.artifactsName = artifactsName;
    this.backend = createCloudflareBackend(this.ctx.storage, this.env.ARTIFACTS, artifactsName, this.env.DB, (p) => this.ctx.waitUntil(p));
  }

  /** The tool surface, by name -- the same ToolDef.execute() contract agent/tools.ts already defines, just reached over RPC instead of an in-process call. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (WORKER_INCOMPATIBLE_TOOLS.has(name)) {
      throw new Error(`"${name}" can't run on a Worker (no child_process, no real git worktrees, no \`gh\` CLI there) -- it's a local-only tool.`);
    }
    const tool = ALL_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    const result = await withBackend(this.backend, () => tool.execute(args));
    if (LANE_SYNCING_TOOLS.has(name)) await this.syncLaneCache(result as Lane);
    return result;
  }

  /**
   * Keeps the D1 lanes/lane_principals cache (worker/migrations/0018)
   * current -- the single chokepoint every lane-mutating call passes
   * through regardless of caller (web app, CLI, TUI), so this is the
   * one place that needs to know about the cache at all. Resolves this
   * DO's own artifactsName to a repo_slug once per call rather than
   * threading repo_slug through every call site's own signature --
   * cheap (an indexed unique lookup), and self-contained here. A repo
   * created before this migration landed (or one somehow missing from
   * `repos` entirely) is silently skipped rather than throwing: the
   * cache is a derived index, never the source of truth, so a gap in
   * it is never a reason to fail the real operation that already
   * succeeded above.
   */
  private async syncLaneCache(lane: Lane): Promise<void> {
    const repoRow = await this.env.DB.prepare("SELECT slug FROM repos WHERE artifacts_name = ?").bind(this.artifactsName).first<{ slug: string }>();
    if (!repoRow) return;
    // A real, pre-existing bug found while verifying #62 live: this
    // column is named origin_repo_slug and every reader (laneOriginKey,
    // webApp.ts -- already used by Explore/profile's own "related Lane"
    // grouping before #62 ever existed) treats it as one, but
    // lane.origin.repo is always the artifacts_name (confirmed earlier
    // this session, #43's own origin_repo fix) -- storing it unresolved
    // meant this column never actually held a real slug for any Lane
    // with a real origin, same-repo child or cross-repo fork alike,
    // silently breaking the rollup everywhere it was ever used. Same
    // slug lookup this function already does for its own repo_slug
    // above, just resolving the ORIGIN's own artifacts_name instead of
    // this DO's.
    const originRepoRow = lane.origin ? await this.env.DB.prepare("SELECT slug FROM repos WHERE artifacts_name = ?").bind(lane.origin.repo).first<{ slug: string }>() : null;
    const now = new Date().toISOString();
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO lanes (repo_slug, lane_id, name, objective, status, origin_repo_slug, origin_lane_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (repo_slug, lane_id) DO UPDATE SET name = excluded.name, objective = excluded.objective, status = excluded.status, origin_repo_slug = excluded.origin_repo_slug, origin_lane_id = excluded.origin_lane_id, updated_at = excluded.updated_at",
      ).bind(repoRow.slug, lane.id, lane.name, lane.objective, lane.status, originRepoRow?.slug ?? null, lane.origin?.lane ?? null, now),
      this.env.DB.prepare("DELETE FROM lane_principals WHERE repo_slug = ? AND lane_id = ?").bind(repoRow.slug, lane.id),
      ...(["owner", "coordinator", "viewer", "committee"] as const).flatMap((role) =>
        lane[role === "owner" ? "owners" : role === "committee" ? "committee" : role === "coordinator" ? "coordinators" : "viewers"].map((principal) =>
          this.env.DB.prepare("INSERT INTO lane_principals (repo_slug, lane_id, principal, role) VALUES (?, ?, ?, ?)").bind(repoRow.slug, lane.id, principal, role),
        ),
      ),
    ]);
  }

  /**
   * #41's one-time migration step: seeds a Lane's owners/coordinators/
   * viewers from a repo's old roles.json grants, exactly once. Not a
   * ToolDef -- deliberately a separate, typed RPC method rather than
   * another string-dispatched callTool() name, so it is NOT reachable
   * through handleApiCallTool's generic /tools/:name passthrough (an
   * external caller supplying their own `owners` there would be a
   * real ownership-hijack hole). Only webApp.ts's own trusted
   * TypeScript code can call this, by calling the method directly on
   * the stub.
   *
   * Refuses outright if the Lane already has any owner -- the self-
   * limiting gate that makes this safe to call unconditionally on
   * every real RBAC check (ensureOriginLaneRoles, webApp.ts): once a
   * repo is migrated, this becomes a permanent no-op for it, so it can
   * never be used to overwrite an already-owned Lane's roles, by
   * anyone, including this same code calling it again.
   */
  async seedOriginLaneRolesIfUnset(laneId: string, owners: string[], coordinators: string[], viewers: string[]): Promise<void> {
    let seeded = false;
    const lane = await withBackend(this.backend, () =>
      this.backend.withLane(this.artifactsName, laneId, (lane) => {
        if (lane.owners.length > 0) return;
        seeded = true;
        lane.owners = owners;
        for (const c of coordinators) if (!lane.coordinators.includes(c)) lane.coordinators.push(c);
        lane.viewers = viewers;
      }),
    );
    if (seeded) await this.syncLaneCache(lane);
  }
}
