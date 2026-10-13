// A lightweight "who else is running zz right now, and on what" --
// the local-mode equivalent of remote mode's `/api/me/repos`: `zz top
// --local` with no config/`--repos` has no server to ask, so it asks
// the filesystem instead. One file per process (keyed by pid, so a
// second process never collides with or overwrites the first's),
// written on start and removed on clean exit; `zz top` unions
// whatever's left, dropping any entry whose pid is no longer running
// (a crash/kill -9 leaves its file behind -- this is the self-healing
// part, not a separate cleanup pass someone has to remember to run).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface RunningEntry {
  pid: number;
  repos: string[];
  startedAt: string;
}

function registryDir(): string {
  return join(homedir(), ".zz", "running");
}

function entryPath(pid: number): string {
  return join(registryDir(), `${pid}.json`);
}

/** Called once at startup (zz work/zz review, local mode only -- remote mode has the server's own /api/me/repos for this) and again any time the watched set grows (a task shard), so a later `zz top --local` sees the full picture, not just the repo(s) the process started with. */
export function registerRunningProcess(repos: string[]): void {
  mkdirSync(registryDir(), { recursive: true });
  const entry: RunningEntry = { pid: process.pid, repos, startedAt: new Date().toISOString() };
  writeFileSync(entryPath(process.pid), JSON.stringify(entry), "utf8");
}

/** Idempotent, best-effort -- safe to call from a SIGINT/SIGTERM handler and a normal finally without erroring on the second call. */
export function unregisterRunningProcess(): void {
  try {
    rmSync(entryPath(process.pid), { force: true });
  } catch {
    // best-effort only
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every repo slug any other (still-alive) local zz process is currently watching, deduped. Stale entries (dead pid) are skipped, not deleted here -- cheap enough to re-check every call, and deleting on someone else's behalf risks a race against that process's own exit cleanup. */
export function listRunningRepos(): string[] {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  const slugs = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, file), "utf8")) as RunningEntry;
      if (entry.pid !== process.pid && !isAlive(entry.pid)) continue;
      for (const slug of entry.repos) slugs.add(slug);
    } catch {
      // a half-written or corrupt entry -- skip rather than fail the whole listing
    }
  }
  return [...slugs];
}
