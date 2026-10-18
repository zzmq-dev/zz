// Shared repo resolution for CLI commands: parses "owner/repo", clones it
// locally if it isn't already (real `git clone`, not isomorphic-git --
// the CLI runs on a human's own machine, not in a Worker, so there's no
// reason not to use the fastest tool available for this one step; only the
// Ladder's own reads/writes go through the Workers-compatible engine).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readAnchor } from "../../engine/ladderNotes.js";
import { REPO_RUNG_PATH } from "../../engine/ladder.js";
import { resolveMe } from "./credentials.js";

// `~/.zz/repos`/`~/.zz/state`, not anywhere relative to this module's own
// location -- same convention as credentials.ts/config.ts's ~/.zz/*.json.
// This used to be package-root-relative (two dirs up from this file), which
// quietly worked only because every real use so far ran straight out of
// the dev repo; a globally `npm install -g`'d copy of this package has no
// business writing a user's real work clones into wherever npm happened to
// put its own installed files (not always writable, not meant to hold user
// data, and gets blown away on upgrade/reinstall).
function zzHome(): string {
  return join(homedir(), ".zz");
}

export interface ResolvedRepo {
  slug: string; // "owner/repo"
  name: string; // "repo"
  repoDir: string; // real clone
  stateDir: string; // our own .zz/ state alongside it
}

export function parseSlug(slug: string): { owner: string; name: string } {
  if (typeof slug !== "string" || !slug) {
    throw new Error(`expected a "repo" argument shaped "owner/repo", got ${JSON.stringify(slug)} -- every tool call that touches a repo needs one, even if you already passed it on an earlier call.`);
  }
  slug = resolveMe(slug);
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`expected "owner/repo", got "${slug}"`);
  }
  return { owner: parts[0], name: parts[1] };
}

export function resolveRepo(slug: string): ResolvedRepo {
  const { owner, name } = parseSlug(slug);
  // Rebuilt from the resolved owner/name, not the original parameter --
  // parseSlug's own "slug = resolveMe(slug)" reassignment is local to
  // its own call frame and never touches this function's `slug`
  // binding. Confirmed live: this returned ResolvedRepo.slug as the
  // raw, still-unresolved "@me/mathkit", so every caller using it
  // directly (not owner/name separately) silently went right back to
  // the unresolved value -- "no such repo \"@me/mathkit\"" the moment
  // anything tried to look it up by that slug.
  slug = `${owner}/${name}`;
  // Nested by a sanitized owner segment, not just `name` -- a bare
  // "demo-repos/<name>" would collide if two different owners (now
  // genuinely possible with remote repos, e.g. two humans' repos both
  // named "shoes") happened to pick the same repo name.
  const ownerDir = owner.replace(/[^a-zA-Z0-9._-]/g, "_");
  // On disk only: a shard's name segment carries bracket-delimited task
  // slugs (computeShardSlug, worker/src/webApp.ts, e.g.
  // "pants[foo][bar]") -- real brackets are legal in a directory name
  // but clunky to type/tab-complete/paste, so locally this becomes a
  // double-underscore delimiter instead ("pants__foo__bar"). `slug` and
  // `name` themselves are untouched -- they're the real identifiers
  // used everywhere else (API calls, display, the protocol itself).
  const nameDir = name.replace(/\[/g, "__").replace(/\]/g, "");
  return {
    slug,
    name,
    repoDir: join(zzHome(), "repos", ownerDir, nameDir),
    stateDir: join(zzHome(), "state", ownerDir, nameDir),
  };
}

// TEMPORARY, pending a Cloudflare fix -- same reasoning as
// cli/commands/repo.ts's repoClone, see its own comment and the case
// study it links (site/content/docs/case-studies/
// git-incremental-fetch-sideband-error): any `have`-line negotiation
// against a repo with real history can corrupt the response
// ("fetch-pack: protocol error: bad band #78"), a real bug in
// Cloudflare Artifacts' own git-upload-pack. This isn't only a risk
// for a user's own `git pull` -- every zz-managed local clone under
// ~/.zz/repos/ runs this same negotiation on its own, repeatedly:
// fetchClone below (called before every claimed ask, remote mode) and
// runCoordinatorSubmitChangeset's own fetch of a shard's objects
// (agent/scriptedWork.ts) both send that clone's own `have` list
// regardless of which remote they're actually fetching from -- found
// live exactly this way, a `zz work` process crashing on a fetch from
// a task shard, not a user-run `git pull` at all. `noop` skips the
// negotiation entirely; see repoClone's own comment for the real
// tradeoff. Set unconditionally, every call, cheap and idempotent --
// this is also the one thing that retroactively protects a clone
// that was already sitting in ~/.zz/repos/ before this existed.
// `git config` takes its own lockfile (`.git/config.lock`) and fails
// fast rather than waiting if a second caller hits it mid-write --
// confirmed live, re-verifying #28's isolation fix: two `zz work`
// processes both starting against the same already-cloned repo at
// once both landed here and one got "could not lock config file:
// File exists". A few short, synchronous retries is enough -- this
// is a single-line config write finishing in milliseconds, not a
// long-held lock -- without needing a real mutex for something this
// brief.
function disableFetchNegotiation(repoDir: string): void {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      execFileSync("git", ["-C", repoDir, "config", "fetch.negotiationAlgorithm", "noop"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return;
    } catch (err) {
      const message = err instanceof Error ? String((err as { stderr?: string }).stderr ?? err.message) : String(err);
      if (attempt === 5 || !/could not lock config file/.test(message)) throw err;
      // A real, portable synchronous sleep -- this function has no
      // async call path available to it (every caller is itself
      // synchronous), so `Atomics.wait` on a throwaway shared buffer is
      // the standard way to block the current thread briefly without
      // spawning a subprocess just to wait a few milliseconds.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

/** `remoteUrl`, when given, is a real git URL with credentials already embedded (cli/lib/credentials.ts's authedCloneUrl) -- the zz Worker's own git smart-HTTP proxy, cloned exactly like any other git remote. Omit it for the original GitHub-based local/demo path, unchanged. */
export function ensureCloned(repo: ResolvedRepo, remoteUrl?: string): void {
  if (existsSync(repo.repoDir)) {
    // Fetch-only (updates origin/main, never resets the shared clone's own
    // working tree) -- see fetchClone's own comment for why. Startup is just
    // as concurrency-prone as any other call site if more than one `zz
    // work` process against this repo happens to start around the same
    // time; whichever worktree a given operation needs gets created fresh,
    // off whatever this fetch just landed, not by resetting this directory.
    if (remoteUrl) {
      disableFetchNegotiation(repo.repoDir);
      fetchClone(repo);
    }
    return;
  }
  console.error(`cloning ${repo.slug}...`);
  // Clone into a uniquely-named temp dir alongside the real target, then
  // atomically rename into place -- found live, re-verifying this exact
  // function for #28: several `zz work` processes starting around the
  // same time against a repo neither has locally yet all see
  // !existsSync at once, and all ran `git clone` straight into
  // `repo.repoDir`. Only the first one can actually create that
  // directory; every other one hard-failed with "could not create work
  // tree dir: File exists" instead of just using the clone that won.
  // `mkdtempSync`'s target has to already exist (it only creates the
  // final unique leaf, not missing parents), and the rename has to land
  // on the same filesystem as `repo.repoDir` to stay atomic, hence
  // creating it as a sibling rather than in the OS temp dir.
  mkdirSync(dirname(repo.repoDir), { recursive: true });
  const tmpDir = mkdtempSync(join(dirname(repo.repoDir), ".clone-tmp-"));
  // Fully suppressed, not inherited -- git's own clone progress on stderr
  // is exactly the kind of raw terminal write that corrupts a live TUI's
  // alternate-screen frame (confirmed live, intermittently, running
  // several real workers -- the same reason agent/tools.ts's
  // run_in_sandbox already suppresses its own git calls this way). Piped
  // rather than ignored on all three streams so a real clone failure's
  // actual git error text still ends up on the thrown error's own
  // .stderr, not lost -- it just never gets a chance to hit the terminal
  // directly.
  try {
    execFileSync("git", ["clone", "--quiet", remoteUrl ?? `https://github.com/${repo.slug}.git`, tmpDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // Set on the still-exclusive tmpDir, before the rename below, not on
    // repo.repoDir after -- every concurrent caller (not just whichever
    // one wins the rename) would otherwise run `git config` against the
    // same shared path at once and race on git's own config lockfile.
    // Each caller's own tmpDir has no concurrent writer, so this never
    // contends, and it travels with whichever clone the rename keeps.
    if (remoteUrl) disableFetchNegotiation(tmpDir);
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
  try {
    renameSync(tmpDir, repo.repoDir);
  } catch (err) {
    // Only swallow this if it's actually the race: some concurrent
    // caller's clone landed at repo.repoDir first, which makes our own
    // (fully valid, just unlucky) clone redundant, not wrong -- discard
    // it and use theirs. Anything else (a real filesystem error) still
    // needs to surface.
    if (!existsSync(repo.repoDir)) throw err;
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Fetches the remote's current `main` into the shared base clone's own
 * remote-tracking ref (`origin/main`) -- needed in remote mode specifically,
 * since other agents' commits land on the real remote, not in this local
 * working copy, between one read and the next (local mode has no such gap:
 * LocalBackend commits land directly in this same repoDir).
 *
 * Fetch-only, deliberately -- this used to also run `git reset --hard
 * origin/main` directly against the shared clone's own working tree, which
 * is exactly what let two concurrent `zz work` processes against the same
 * repo corrupt each other (confirmed live: "fatal: path '<file>' exists on
 * disk, but not in '<sha>'" -- one process's reset yanking files out from
 * under the other's in-progress read). A `git fetch` only updates a
 * remote-tracking ref, which git's own ref-locking already serializes
 * safely across concurrent callers; it never touches the working tree, so
 * it's safe to call from as many concurrent processes as actually show up.
 * Each one now resets into its own isolated worktree instead (see
 * ensureWorktree below) -- the shared base clone's own working tree should
 * never be reset or checked out in directly once a repo has any concurrent
 * users at all.
 *
 * Noteworthy, not a bug: after this runs, `git status` inside the base
 * clone's own directory will show every tracked file as "modified" --
 * expected, not a sign anything is wrong. Moving `refs/heads/main` (below)
 * without touching the checked-out files on disk means the base clone's
 * working tree no longer matches its own HEAD, on purpose. Nothing in this
 * codebase reads or writes that working tree directly anymore -- only
 * `git worktree add`, which checks out fresh content from the object
 * database at whatever ref it's given, never from the base's own
 * (intentionally stale-looking) working-tree files. Resist the urge to
 * "clean this up" with a reset or checkout here; that's exactly the
 * mutation that caused the original race this function exists to avoid.
 */
export function fetchClone(repo: ResolvedRepo): void {
  disableFetchNegotiation(repo.repoDir);
  // Fully suppressed, not inherited -- see ensureCloned's own comment on
  // the clone call above; this one runs on every claimed ask in remote
  // mode, so it's the single most frequent source of exactly this kind
  // of TUI corruption, confirmed live.
  execFileSync("git", ["-C", repo.repoDir, "fetch", "--quiet", "origin", "main"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // Ref-only, like the fetch above -- moves the LOCAL `main` branch to
  // point at whatever origin/main now does, without touching the working
  // tree, the index, or HEAD's own symbolic-ref target at all (unlike
  // `git checkout`/`git reset`, which this deliberately isn't using; see
  // this file's own git history for why those are unsafe here).
  //
  // This is what keeps a plain `"HEAD"` -- the default ref every
  // worktree-creation call in this codebase resolves against
  // (ensureWorktree's own default, and agent/tools.ts's run_in_sandbox,
  // which re-resolves a repo from its slug independently and hardcodes
  // "HEAD") -- correct for a remote-mode repo too, without needing every
  // caller to know or care whether a given repo is in remote or local
  // mode before picking a ref. Harmless to run redundantly for a local-
  // mode repo (this function is never called for one -- ensureCloned
  // only calls it when a remoteUrl was given).
  execFileSync("git", ["-C", repo.repoDir, "update-ref", "refs/heads/main", "refs/remotes/origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Reads CHARTER.md off the repo's `zz-meta` branch, or null if it
 * doesn't exist. Deliberately plain git (`git fetch` + `git show`),
 * not a dedicated tool or API surface -- the explicit decision for
 * Charter's storage (see site/content/docs/charter/): editing it is
 * ordinary git against zz-meta, so reading it should be too. `main`'s
 * own fetch (fetchClone, above) never touches zz-meta, so this does
 * its own small, ref-only fetch first -- cheap (one tiny branch's
 * history, not the whole repo) and keeps a Charter edit pickup-able
 * without needing a full re-clone.
 */
export function readCharter(repo: ResolvedRepo): string | null {
  try {
    execFileSync("git", ["-C", repo.repoDir, "fetch", "--quiet", "origin", "zz-meta"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null; // no zz-meta branch at all yet (repo never had one created) -- not an error, just nothing to read
  }
  try {
    return execFileSync("git", ["-C", repo.repoDir, "show", "FETCH_HEAD:CHARTER.md"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null; // zz-meta exists but has no CHARTER.md yet
  }
}

/**
 * Creates an isolated git worktree off `repo`'s own shared base clone,
 * detached at `ref`. Returns a ResolvedRepo-shaped object whose `repoDir`
 * points at the worktree instead of the shared clone -- every existing
 * caller that already takes a ResolvedRepo and touches `.repoDir`
 * (runWorkAsk, runCoordinatorSubmitChangeset, runResolveConflict, the whole
 * fileContentAtCommit/commitChangeset path) keeps working completely
 * unchanged, now isolated from every other concurrent operation's own
 * worktree without needing to know that's what happened. `stateDir` is left
 * pointing at the base repo's own -- it's a shared Ladder-anchor cache, not
 * per-operation state, and isolating it would just cause redundant anchor
 * recomputation for no benefit.
 *
 * Same underlying pattern agent/tools.ts's `run_in_sandbox` already uses
 * for disposable test checkouts (`git worktree add --detach`, stdio fully
 * suppressed so git's own progress text never leaks into a live TUI frame)
 * -- reused here rather than invented twice, just scoped to a whole
 * claimed-ask operation instead of one tool call. The container/subdirectory
 * split (mkdtemp the container, let `worktree add` create the not-yet-
 * existing path inside it) is the same trick for the same reason: `git
 * worktree add` wants to create its own target directory, not be handed one
 * that already exists.
 *
 * Multiple worktrees safely share one base clone's object store and
 * remote-tracking refs -- only a *shared working tree* was ever unsafe for
 * concurrent use. The base clone itself must never be reset/checked-out-in
 * directly once this exists for a repo; `fetchClone` (ref-only) is the only
 * thing that should still touch it directly.
 */
export function ensureWorktree(repo: ResolvedRepo, ref: string): ResolvedRepo {
  const worktreesRoot = join(zzHome(), "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  const container = mkdtempSync(join(worktreesRoot, "zz-"));
  const worktreeDir = join(container, repo.name);
  execFileSync("git", ["-C", repo.repoDir, "worktree", "add", "--detach", "--quiet", worktreeDir, ref], { stdio: ["ignore", "ignore", "ignore"] });
  return { ...repo, repoDir: worktreeDir };
}

/**
 * Removes a worktree created by `ensureWorktree`. `base` is the ORIGINAL
 * (non-worktree) ResolvedRepo passed to `ensureWorktree` -- `git worktree
 * remove` has to run against the shared base clone's own `.git` directory,
 * which knows about the worktree; the worktree's own copy doesn't carry
 * that bookkeeping. Best-effort: tolerates one already gone (a process that
 * crashed before cleanup, a second call), same idempotency convention as
 * this file's other cleanup paths.
 */
export function removeWorktree(base: ResolvedRepo, worktree: ResolvedRepo): void {
  try {
    execFileSync("git", ["-C", base.repoDir, "worktree", "remove", "--force", worktree.repoDir], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // best-effort
  }
  try {
    rmSync(dirname(worktree.repoDir), { recursive: true, force: true });
  } catch {
    // best-effort -- `worktree remove` above already deletes the directory
    // on success; this only matters if that failed and left it behind.
  }
}

/**
 * Runs `fn` against an isolated git worktree of `repo` checked out at
 * `ref`, always removing the worktree afterward -- success, thrown error,
 * doesn't matter. The one place anything in this codebase gets a safe,
 * ephemeral, isolated checkout for a claimed-ask-shaped operation whose
 * working tree nobody needs to look at once `fn` returns.
 *
 * Deliberately just `ensureWorktree` + `removeWorktree` wrapped around a
 * callback -- every caller that used to hand-roll its own worktree-create-
 * then-cleanup dance (work.ts's workClaimed, ladder-sync.ts's ladderSync,
 * scriptedWork.ts's proposeReview) goes through this one function instead
 * of repeating the same three-line pattern a third and fourth time.
 * Principle #5, invent as little as possible, applied to this codebase's
 * own internals, not just external standards.
 *
 * NOT what you want if the caller needs the checkout to still exist after
 * this returns -- a human inspecting a proposed changeset's real files
 * (prepareReviewWorkspace, below) calls `ensureWorktree` directly instead,
 * on purpose, and is responsible for its own, later cleanup.
 *
 * Callers are still responsible for fetching first if they need to
 * (fetchClone for an already-cloned repo, ensureCloned if it might not
 * exist locally at all yet) -- that decision genuinely differs per caller,
 * so this only owns the isolation, not the refresh policy.
 */
export async function withIsolatedRepo<T>(repo: ResolvedRepo, ref: string, fn: (isolated: ResolvedRepo) => Promise<T>): Promise<T> {
  const isolated = ensureWorktree(repo, ref);
  try {
    return await fn(isolated);
  } finally {
    removeWorktree(repo, isolated);
  }
}

/**
 * Like `ensureWorktree`, but at a deterministic path keyed by `name`
 * instead of a fresh one every call -- reused (fast-forwarded to `ref`) on
 * a second call with the same name, rather than creating a second worktree
 * alongside the first. For the one real case that needs a worktree to
 * still be there, unchanged, after the call returns, and across any number
 * of repeat calls: a changeset_review's workspace (`prepareReviewWorkspace`,
 * agent/scriptedWork.ts), which a human needs to `cd` into and inspect,
 * possibly across more than one --assist turn on the same ask. Caller owns
 * cleanup -- there's no automatic removal here the way `withIsolatedRepo`
 * has; removing this early would delete the thing the caller exists to
 * produce.
 */
export function ensureNamedWorktree(repo: ResolvedRepo, name: string, ref: string): ResolvedRepo {
  const worktreeDir = join(zzHome(), "worktrees", "named", name);
  if (existsSync(worktreeDir)) {
    execFileSync("git", ["-C", worktreeDir, "reset", "--quiet", "--hard", ref], { stdio: ["ignore", "ignore", "ignore"] });
  } else {
    mkdirSync(dirname(worktreeDir), { recursive: true });
    execFileSync("git", ["-C", repo.repoDir, "worktree", "add", "--detach", "--quiet", worktreeDir, ref], { stdio: ["ignore", "ignore", "ignore"] });
  }
  return { ...repo, repoDir: worktreeDir };
}

/** Same definition `zz ladder build` itself uses to decide whether the file tree already got onboarded (cli/commands/ladder-build.ts's own isPresent check on REPO_RUNG_PATH) -- not a new check, just this one reused so `zz top --local`'s discovery agrees with onboarding about what "onboarded" means. No existsSync short-circuit on stateDir: confirmed live that readAnchor finds real content (it's a git note on repoDir's own clone) even when stateDir doesn't exist on disk at all, so a "does the directory exist" guard here only produces false negatives. */
export async function isLocallyOnboarded(repo: ResolvedRepo): Promise<boolean> {
  return (await readAnchor(repo.repoDir, repo.stateDir, REPO_RUNG_PATH)) !== null;
}

/** Walks up from `dir` (default: cwd) to find the enclosing git repo (if any) and parses its `origin` remote as a GitHub "owner/repo" slug. Null for a non-git directory, a git repo with no `origin`, or an origin that isn't github.com -- `zz ladder build` itself only supports GitHub-hosted repos (clones from github.com, fetches issues/PRs via the GitHub API), so there's no onboarding command to suggest for anything else; callers should say so plainly rather than inventing one. */
export function inferGitHubSlugFromDir(dir: string = process.cwd()): string | null {
  let root: string;
  try {
    root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null; // not inside a git repo
  }
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null; // no "origin" remote
  }
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** `inferGitHubSlugFromDir`, defaulted to the process's own cwd -- kept as a separate named export since most callers (top.ts's startup discovery) want exactly that and shouldn't have to pass `process.cwd()` explicitly. */
export function inferGitHubSlugFromCwd(): string | null {
  return inferGitHubSlugFromDir();
}
