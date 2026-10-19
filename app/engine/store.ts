// .zz/ persistence: a SQLite db (one per repo, `.zz/zz.db`) via Node's
// built-in `node:sqlite` -- no new dependency, no native-module build
// risk. Replaces the earlier flat-JSON-file version specifically to fix
// a real race: two `zz work` processes concurrently acting on the same
// Lane (a plain read-mutate-write across two file I/O calls has a
// window where one process's write can clobber the other's). SQLite's
// own locking (BEGIN IMMEDIATE below) makes the read-modify-write in
// `withLane` atomic across processes, not just within one. This also
// doubles as a closer rehearsal for the eventual Durable Object (which
// is SQLite-backed too, per site/content/remote-backend/index.md) than
// flat files ever were.
//
// Migration: a repo's existing `.zz/lanes/*.json` (and `.zz/roles/*.json`)
// files, if present, are imported into the db once, the first time it's
// created -- the old files are left in place afterward (not read again,
// not deleted) rather than risking data loss on an already-committed
// demo repo's state.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentRoles, Lane } from "./types.js";

function zzRoot(repoStateDir: string): string {
  return join(repoStateDir, ".zz");
}

const dbCache = new Map<string, DatabaseSync>();

function migrateFlatFiles(db: DatabaseSync, root: string): void {
  const lanesDir = join(root, "lanes");
  if (existsSync(lanesDir)) {
    for (const f of readdirSync(lanesDir)) {
      if (!f.endsWith(".json")) continue;
      const data = readFileSync(join(lanesDir, f), "utf8");
      const lane = JSON.parse(data) as Lane;
      db.prepare("INSERT OR REPLACE INTO lanes (id, data) VALUES (?, ?)").run(lane.id, data);
    }
  }
  const rolesDir = join(root, "roles");
  if (existsSync(rolesDir)) {
    for (const f of readdirSync(rolesDir)) {
      if (!f.endsWith(".json")) continue;
      const data = readFileSync(join(rolesDir, f), "utf8");
      const roles = JSON.parse(data) as AgentRoles;
      db.prepare("INSERT OR REPLACE INTO roles (agent, data) VALUES (?, ?)").run(roles.agent, data);
    }
  }
}

function getDb(repoStateDir: string): DatabaseSync {
  const root = zzRoot(repoStateDir);
  const dbPath = join(root, "zz.db");
  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  mkdirSync(root, { recursive: true });
  const isNew = !existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000"); // wait briefly on a lock held by another process instead of failing immediately -- set before anything else that could itself contend for the lock
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS roles (agent TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS decisions (commit_sha TEXT PRIMARY KEY, data TEXT NOT NULL)");
  if (isNew) migrateFlatFiles(db, root);
  dbCache.set(dbPath, db);
  return db;
}

// A Lane persisted before the Maintainer->Coordinator rename has
// `maintainers` baked into its stored JSON, not `committee` -- the
// rename only changed what new code reads and writes, not what's
// already sitting on disk. Without this, an already-existing local
// Lane would silently come back with `committee: undefined` after an
// upgrade, breaking voting and the review backstop on it. Applied at
// every read path below, not just one.
function migrateLane(lane: Lane): Lane {
  if (lane.committee === undefined) {
    const legacy = lane as unknown as { maintainers?: string[] };
    lane.committee = legacy.maintainers ?? lane.coordinators;
  }
  // #41: owners/viewers didn't exist before tonight -- same fix as
  // worker/src/cloudflareBackend.ts's own migrateLane, see its doc
  // comment for the live crash this was found from.
  if (lane.owners === undefined) lane.owners = [];
  if (lane.viewers === undefined) lane.viewers = [];
  return lane;
}

export function readLane(repoStateDir: string, laneId: string): Lane | null {
  const row = getDb(repoStateDir).prepare("SELECT data FROM lanes WHERE id = ?").get(laneId) as { data: string } | undefined;
  return row ? migrateLane(JSON.parse(row.data) as Lane) : null;
}

export function writeLane(repoStateDir: string, lane: Lane): void {
  getDb(repoStateDir).prepare("INSERT OR REPLACE INTO lanes (id, data) VALUES (?, ?)").run(lane.id, JSON.stringify(lane, null, 2));
}

export function listLanes(repoStateDir: string): Lane[] {
  const rows = getDb(repoStateDir).prepare("SELECT data FROM lanes").all() as { data: string }[];
  return rows.map((r) => migrateLane(JSON.parse(r.data) as Lane));
}

/**
 * Atomic read-modify-write for a single Lane: the whole thing runs
 * inside one SQLite transaction (BEGIN IMMEDIATE takes the write lock
 * up front), so two processes racing to act on the same Lane serialize
 * instead of one silently clobbering the other's change. `mutate` edits
 * the Lane in place; its return value is what gets persisted and
 * returned.
 */
export function withLane(repoStateDir: string, laneId: string, mutate: (lane: Lane) => void): Lane {
  const db = getDb(repoStateDir);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT data FROM lanes WHERE id = ?").get(laneId) as { data: string } | undefined;
    if (!row) throw new Error(`no such lane: ${laneId}`);
    const lane = migrateLane(JSON.parse(row.data) as Lane);
    mutate(lane);
    db.prepare("INSERT OR REPLACE INTO lanes (id, data) VALUES (?, ?)").run(lane.id, JSON.stringify(lane, null, 2));
    db.exec("COMMIT");
    return lane;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function readRoles(repoStateDir: string, agent: string): AgentRoles | null {
  const row = getDb(repoStateDir).prepare("SELECT data FROM roles WHERE agent = ?").get(agent) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as AgentRoles) : null;
}

export function writeRoles(repoStateDir: string, agentRoles: AgentRoles): void {
  getDb(repoStateDir).prepare("INSERT OR REPLACE INTO roles (agent, data) VALUES (?, ?)").run(agentRoles.agent, JSON.stringify(agentRoles, null, 2));
}

export function writeDecision(repoStateDir: string, commitSha: string, decision: unknown): void {
  getDb(repoStateDir).prepare("INSERT OR REPLACE INTO decisions (commit_sha, data) VALUES (?, ?)").run(commitSha, JSON.stringify(decision, null, 2));
}

// Ladder storage lives in git notes (see engine/ladderNotes.ts), not here:
// a rung is an annotation on a git object, not a standalone coordination
// record the way a Lane or Role grant is.
