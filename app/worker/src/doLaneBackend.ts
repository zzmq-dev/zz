// Lane/Ask/Answer storage on a Durable Object's own SQLite storage --
// step 3 of site/content/remote-backend/index.md's build sequencing.
// Mirrors engine/store.ts's schema and withLane's transactional
// semantics exactly (ctx.storage.transactionSync is the DO equivalent
// of local SQLite's BEGIN IMMEDIATE/COMMIT/ROLLBACK), so the two
// behave identically from engine/lane.ts's point of view -- which
// never needs to know which one it's talking to.
//
// Git-content methods are NOT implemented here yet (deliberately --
// that's step 4, alongside the tool-surface routes): this backend
// serves exactly one DO instance, which serves exactly one repo, so
// there's nothing to key git content on yet that a separate piece
// won't need anyway.
import type { Backend } from "../../engine/backend.js";
import type { Lane } from "../../engine/types.js";

export function createDoLaneBackend(storage: DurableObjectStorage): Backend {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, data TEXT NOT NULL)");

  function readLane(_repo: string, laneId: string): Lane | null {
    const row = sql.exec("SELECT data FROM lanes WHERE id = ?", laneId).toArray()[0] as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Lane) : null;
  }

  function writeLane(_repo: string, lane: Lane): void {
    sql.exec("INSERT OR REPLACE INTO lanes (id, data) VALUES (?, ?)", lane.id, JSON.stringify(lane));
  }

  return {
    name: "cloudflare-do-lane-only",

    ensureCloned() {
      throw new Error("doLaneBackend: git content not implemented yet (step 4)");
    },
    listCommits() {
      throw new Error("doLaneBackend: git content not implemented yet (step 4)");
    },
    diffCommit() {
      throw new Error("doLaneBackend: git content not implemented yet (step 4)");
    },
    readFileAtCommit() {
      throw new Error("doLaneBackend: git content not implemented yet (step 4)");
    },
    async commitChangeset() {
      throw new Error("doLaneBackend: git content not implemented yet (step 4)");
    },
    async readAnchor() {
      throw new Error("doLaneBackend: the Ladder not implemented yet (step 4)");
    },
    async writeLadder() {
      throw new Error("doLaneBackend: the Ladder not implemented yet (step 4)");
    },
    async appendRepoChildren() {
      throw new Error("doLaneBackend: the Ladder not implemented yet (step 4)");
    },

    readLane,
    writeLane,
    listLanes(_repo: string): Lane[] {
      return sql.exec("SELECT data FROM lanes").toArray().map((r) => JSON.parse((r as { data: string }).data) as Lane);
    },
    withLane(repo: string, laneId: string, mutate: (lane: Lane) => void): Lane {
      return storage.transactionSync(() => {
        const lane = readLane(repo, laneId);
        if (!lane) throw new Error(`no such lane: ${laneId}`);
        mutate(lane);
        writeLane(repo, lane);
        return lane;
      });
    },
  };
}
