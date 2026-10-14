// The one piece of state an incremental sync needs that nothing else
// already tracks: which commit of the real GitHub source was last
// pushed into the remote zz repo. `zz ladder push` writes this right
// after a successful initial import, giving `zz ladder sync` (which
// reads it) a real baseline from the very first run onward, without
// needing its own separate "init sync state" step.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SyncState {
  lastSyncedCommit: string;
}

function syncStatePath(stateDir: string): string {
  return join(stateDir, ".zz", "sync-state.json");
}

export function readSyncState(stateDir: string): SyncState | null {
  const path = syncStatePath(stateDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SyncState;
}

export function writeSyncState(stateDir: string, lastSyncedCommit: string): void {
  const path = syncStatePath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ lastSyncedCommit } satisfies SyncState, null, 2) + "\n");
}
