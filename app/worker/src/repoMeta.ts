// Repo-level metadata (description, policy, repo-level Role grants) on
// a dedicated `zz-meta` orphan branch -- the orphan-branch twin of
// site/content/data-format/index.md's `.zz/` directory (policy.yaml,
// roles/<agent-id>.json), moved off the main branch so bot-written
// protocol state doesn't clutter a repo's real history/diffs.
//
// Unlike the Ladder's notes refs (cloudflareLadderBackend.ts) this is
// a REAL branch: a scoped single-branch fetch pulls the full, small
// object graph for just this branch locally, so unlike the main
// branch's git-content path (cloudflareGitBackend.ts) there's no need
// to avoid cloning -- a repo's zz-meta history is tiny (one commit per
// metadata change, not the project's real development history).
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createMemFs } from "./memFs.js";
import type { RepoPolicy } from "../../engine/types.js";
import { DEFAULT_REPO_POLICY } from "../../engine/policy.js";

export type { RepoPolicy };

export const META_REF = "refs/heads/zz-meta";

export interface RepoMeta {
  description: string;
  policy: RepoPolicy;
  owner: string; // an Agent's username -- every principal is an Agent, human or synthetic, no type tag (see governance.md); no separate internal id (see migration 0006)
  shard_of?: string; // immediate-parent repo slug, if this repo is a task shard (see webApp.ts's ensureShard) -- absent for an ordinary repo
  created_at: string;
}

export type RbacRole = "owner" | "coordinator" | "contributor" | "viewer";

export interface RoleGrant {
  principal: string; // bare agent id
  role: RbacRole;
  granted_by: string;
  at: string;
}

export interface RepoRoles {
  grants: RoleGrant[];
}

function tokenString(token: { plaintext: string } | string): string {
  return typeof token === "string" ? token.split("?")[0] : token.plaintext;
}

async function scopedBranchCheckout(remote: string, token: { plaintext: string } | string): Promise<{ fs: ReturnType<typeof createMemFs>; dir: string; headOid: string | null }> {
  const fs = createMemFs();
  const dir = "/meta";
  await git.init({ fs, dir, defaultBranch: "main" });
  await git.addRemote({ fs, dir, remote: "origin", url: remote });
  const onAuth = () => ({ username: "x-token-auth", password: tokenString(token) });
  try {
    const result = await git.fetch({ fs, http, dir, remote: "origin", onAuth, ref: META_REF, remoteRef: META_REF, singleBranch: true, tags: false });
    if (result.fetchHead) {
      await git.writeRef({ fs, dir, ref: META_REF, value: result.fetchHead, force: true });
      return { fs, dir, headOid: result.fetchHead };
    }
    return { fs, dir, headOid: null };
  } catch {
    // Branch doesn't exist yet on the remote -- first write ever.
    return { fs, dir, headOid: null };
  }
}

async function readFileAt(fs: ReturnType<typeof createMemFs>, dir: string, headOid: string, path: string): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: headOid, filepath: path });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

/** Reads one file (e.g. "meta.json", "roles.json") off the zz-meta branch, or null if the branch or file doesn't exist yet. */
export async function readMetaFile(remote: string, token: { plaintext: string } | string, path: string): Promise<string | null> {
  const { fs, dir, headOid } = await scopedBranchCheckout(remote, token);
  if (!headOid) return null;
  return readFileAt(fs, dir, headOid, path);
}

type MemFs = ReturnType<typeof createMemFs>;

/**
 * Recursively writes `files` (arbitrarily nested paths, e.g.
 * "lanes/ask-abc/history/00007.json") into the tree rooted at
 * `baseTreeOid` (an empty tree if null), creating or updating nested
 * subtrees only along the paths actually touched. A sibling file or
 * whole subtree elsewhere in the base tree is carried forward by its
 * existing oid, unread and unwritten -- the same reason a commit that
 * touches one file in a real monorepo doesn't cost proportionally to
 * the whole repo. #27 needed this: the flat, single-level
 * implementation writeMetaFiles had until now (reading/rewriting
 * every root-level entry on every call) would have made every zz-meta
 * write -- not just Lane exports -- progressively more expensive as
 * exported Lane history accumulated at the root. Returns the new root
 * tree's oid.
 */
export async function writeFilesIntoTree(fs: MemFs, dir: string, baseTreeOid: string | null, files: { path: string; content: string }[]): Promise<string> {
  const baseEntries = baseTreeOid ? (await git.readTree({ fs, dir, oid: baseTreeOid })).tree : [];
  const keep = new Map(baseEntries.map((e) => [e.path, e] as const));

  const directLeaves: { path: string; content: string }[] = [];
  const nestedBySegment = new Map<string, { path: string; content: string }[]>();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash === -1) {
      directLeaves.push(f);
    } else {
      const head = f.path.slice(0, slash);
      const rest = f.path.slice(slash + 1);
      if (!nestedBySegment.has(head)) nestedBySegment.set(head, []);
      nestedBySegment.get(head)!.push({ path: rest, content: f.content });
    }
  }

  for (const f of directLeaves) {
    const oid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(f.content) });
    keep.set(f.path, { mode: "100644", path: f.path, oid, type: "blob" });
  }
  for (const [head, nestedFiles] of nestedBySegment) {
    const existing = keep.get(head);
    const childBaseOid = existing && existing.type === "tree" ? existing.oid : null;
    const childTreeOid = await writeFilesIntoTree(fs, dir, childBaseOid, nestedFiles);
    keep.set(head, { mode: "040000", path: head, oid: childTreeOid, type: "tree" });
  }

  return git.writeTree({ fs, dir, tree: Array.from(keep.values()) });
}

/** Writes/overwrites one or more files (any nesting depth) on the zz-meta branch in a single commit, preserving every other existing file untouched. */
export async function writeMetaFiles(remote: string, token: { plaintext: string } | string, files: { path: string; content: string }[], message: string): Promise<void> {
  const { fs, dir, headOid } = await scopedBranchCheckout(remote, token);

  const baseTreeOid = headOid ? (await git.readCommit({ fs, dir, oid: headOid })).commit.tree : null;
  const treeOid = await writeFilesIntoTree(fs, dir, baseTreeOid, files);
  const person = { name: "zz-meta", email: "zz-meta@local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  const commitOid = await git.writeCommit({ fs, dir, commit: { message, tree: treeOid, parent: headOid ? [headOid] : [], author: person, committer: person } });
  await git.writeRef({ fs, dir, ref: META_REF, value: commitOid, force: true });

  const onAuth = () => ({ username: "x-token-auth", password: tokenString(token) });
  const pushResult = await git.push({ fs, http, dir, url: remote, onAuth, ref: META_REF, remoteRef: META_REF });
  if (!pushResult.ok) throw new Error(`push of ${META_REF} rejected: ${JSON.stringify(pushResult.refs)}`);
}

export async function readRepoMeta(remote: string, token: { plaintext: string } | string): Promise<RepoMeta | null> {
  const raw = await readMetaFile(remote, token, "meta.json");
  return raw ? (JSON.parse(raw) as RepoMeta) : null;
}

export async function readRepoRoles(remote: string, token: { plaintext: string } | string): Promise<RepoRoles | null> {
  const raw = await readMetaFile(remote, token, "roles.json");
  return raw ? (JSON.parse(raw) as RepoRoles) : null;
}

/** Both files in ONE scoped checkout, not two independent ones -- readRepoMeta/readRepoRoles called separately (as webApp.ts's getRepoAccessContext used to) each pay for their own full git fetch of the zz-meta branch, even though they always want the exact same branch at the exact same moment. This is the one real fix for a repo page's own load time: every view was doing three of these fetches (this would-be-combined one, plus a THIRD hidden inside an unconditional ensureMeta existence-check) before being folded into this single call. */
export async function readRepoMetaAndRoles(remote: string, token: { plaintext: string } | string): Promise<{ meta: RepoMeta | null; roles: RepoRoles | null }> {
  const { fs, dir, headOid } = await scopedBranchCheckout(remote, token);
  if (!headOid) return { meta: null, roles: null };
  const [metaRaw, rolesRaw] = await Promise.all([readFileAt(fs, dir, headOid, "meta.json"), readFileAt(fs, dir, headOid, "roles.json")]);
  return { meta: metaRaw ? (JSON.parse(metaRaw) as RepoMeta) : null, roles: rolesRaw ? (JSON.parse(rolesRaw) as RepoRoles) : null };
}

/** Creates the zz-meta branch with default meta.json/roles.json if it doesn't exist yet -- lazy bootstrap, called on repo creation or first web view of a pre-existing repo. No-op if meta.json already exists. */
export async function ensureMeta(remote: string, token: { plaintext: string } | string, defaults: { description: string; owner: string; shardOf?: string }): Promise<void> {
  const existing = await readRepoMeta(remote, token);
  if (existing) return;

  const meta: RepoMeta = {
    description: defaults.description,
    policy: DEFAULT_REPO_POLICY,
    owner: defaults.owner,
    ...(defaults.shardOf ? { shard_of: defaults.shardOf } : {}),
    created_at: new Date().toISOString(),
  };
  const roles: RepoRoles = {
    grants: [{ principal: defaults.owner, role: "owner", granted_by: "system", at: meta.created_at }],
  };
  await writeMetaFiles(remote, token, [
    { path: "meta.json", content: JSON.stringify(meta, null, 2) },
    { path: "roles.json", content: JSON.stringify(roles, null, 2) },
  ], "zz-meta: initialize");
}

export async function writeRepoRoles(remote: string, token: { plaintext: string } | string, roles: RepoRoles): Promise<void> {
  await writeMetaFiles(remote, token, [{ path: "roles.json", content: JSON.stringify(roles, null, 2) }], "zz-meta: update roles");
}

export async function writeRepoMeta(remote: string, token: { plaintext: string } | string, meta: RepoMeta): Promise<void> {
  await writeMetaFiles(remote, token, [{ path: "meta.json", content: JSON.stringify(meta, null, 2) }], "zz-meta: update meta");
}

// Repo-level RBAC rank -- the same 4-role cut competition-plan.md
// names (Owner, Coordinator, Contributor, Viewer; Committer dropped).
// Deliberately separate from engine/roles.ts's path-scoped version:
// that one ranks grants by scope (a directory prefix) for a future,
// finer-grained use; a repo-level grant here has no scope to check.
export const RBAC_RANK: Record<RbacRole, number> = { viewer: 0, contributor: 1, coordinator: 2, owner: 3 };

/** Highest repo-level Role an Agent (by id) holds, or "viewer" (view-only) if ungranted -- the default for a public repo. */
export function repoRoleFor(roles: RepoRoles | null, principal: string): RbacRole {
  if (!roles) return "viewer";
  let best: RbacRole = "viewer";
  for (const grant of roles.grants) {
    if (grant.principal === principal && RBAC_RANK[grant.role] > RBAC_RANK[best]) best = grant.role;
  }
  return best;
}

export function repoAtLeast(role: RbacRole, minimum: RbacRole): boolean {
  return RBAC_RANK[role] >= RBAC_RANK[minimum];
}

export class RbacError extends Error {
  constructor(principal: string, action: string, required: RbacRole) {
    super(`${principal} cannot ${action}: requires at least "${required}"`);
  }
}

export function requireRepoRole(roles: RepoRoles | null, principal: string, minimum: RbacRole, action: string): void {
  const role = repoRoleFor(roles, principal);
  if (!repoAtLeast(role, minimum)) throw new RbacError(principal, action, minimum);
}
