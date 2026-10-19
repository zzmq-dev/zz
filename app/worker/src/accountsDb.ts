// D1 query helpers for the agents/tokens/sessions/repos model --
// migration 0002's header covers why there's one identity table, not
// an accounts-owns-agents hierarchy; migration 0006's header covers
// why `username`/`slug` are the real primary keys (agents.id and
// repos.id used to exist as separate opaque ids -- removed once both
// were confirmed unique and immutable, which is all a surrogate key
// would have bought you). repoMeta.ts's header covers why `repos` is
// an index/cache, not the source of truth (agents/tokens/sessions
// have no git home, so D1 *is* authoritative for those).
import { randomBytes } from "node:crypto";
import { RBAC_RANK, type RbacRole } from "./repoMeta.js";

export interface Agent {
  username: string; // the real primary key -- a human's real email; a managed agent's "<creator's username>[<name>]" (see computeUsername)
  display_name: string;
  email: string | null;
  created_at: string;
  created_by: string | null; // provenance only (another agent's username), never an authority relationship
}

export interface AgentIdentity {
  id: string;
  agent_username: string;
  provider: "cloudflare" | "google";
  provider_subject: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  created_at: string;
}

export interface AgentToken {
  id: string;
  agent_username: string;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface Session {
  id: string;
  agent_username: string;
  created_at: string;
  expires_at: string;
}

export interface RepoRow {
  slug: string; // the real primary key -- "<owner username>/<repo name>", frozen at creation
  artifacts_name: string; // a different system's key (Cloudflare Artifacts), not redundant with slug
  description: string | null;
  owner_username: string;
  visibility: "public" | "private";
  shard_of_slug: string | null; // immediate-parent repo this was forked from as a task shard, or null for an ordinary repo -- see webApp.ts's ensureShard
  // 'ingesting' for as long as a bulk import (`zz ladder push`) or
  // future incremental sync is still writing -- set back to 'ready'
  // only on that run's own success, so a run that fails or is killed
  // mid-way leaves the repo correctly flagged not-ready rather than
  // silently reverting. Gates discovery (INGEST_VISIBLE_CLAUSE below),
  // not the repo's own page -- its owner can always open it directly
  // to watch progress.
  ingest_status: "ready" | "ingesting";
  created_at: string;
  updated_at: string;
}

export interface CliLoginSession {
  nonce: string;
  agent_username: string | null;
  token: string | null;
  created_at: string;
  consumed: number;
}

export function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function usernameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/** `base`, or `base-2`/`base-3`/... if already taken -- usernames are frozen at creation (createAgent), so collisions are only ever checked once, here. */
async function uniqueUsername(db: D1Database, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await db.prepare("SELECT 1 FROM agents WHERE username = ?").bind(candidate).first()) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

export async function findAgentIdentity(db: D1Database, provider: string, providerSubject: string): Promise<AgentIdentity | null> {
  return db.prepare("SELECT * FROM agent_identities WHERE provider = ? AND provider_subject = ?").bind(provider, providerSubject).first<AgentIdentity>();
}

export async function getAgent(db: D1Database, username: string): Promise<Agent | null> {
  return db.prepare("SELECT * FROM agents WHERE username = ?").bind(username).first<Agent>();
}

/** The agent a verified email already belongs to, if any -- used to link a second OAuth provider to an EXISTING agent instead of minting a disconnected duplicate (see handleAuthCallback's header comment for the real bug this closes). */
export async function getAgentByEmail(db: D1Database, email: string): Promise<Agent | null> {
  return db.prepare("SELECT * FROM agents WHERE email = ? LIMIT 1").bind(email).first<Agent>();
}

/** A human's username is just their real email -- nothing else to compute. A managed/synthetic agent has none, so its username chains off whoever created it: `<creator's username>[<this agent's own name>]`, e.g. "thoward37@gmail.com[claude]", or "thoward37@gmail.com[claude][helper]" for an agent that agent itself creates. Bracket notation (not "#", which starts a URL fragment and would never even reach the server) -- `[`/`]` are outside the WHATWG URL spec's path percent-encode set, so they pass through a path segment unencoded. */
async function computeUsername(db: D1Database, displayName: string, email: string | null, createdBy: string | null): Promise<string> {
  if (email) return uniqueUsername(db, email);
  const creator = createdBy ? await getAgent(db, createdBy) : null;
  const base = creator ? `${creator.username}[${usernameSlug(displayName)}]` : usernameSlug(displayName);
  return uniqueUsername(db, base);
}

export async function createAgent(db: D1Database, displayName: string, email: string | null, createdBy: string | null): Promise<Agent> {
  const username = await computeUsername(db, displayName, email, createdBy);
  const agent: Agent = { username, display_name: displayName, email, created_at: new Date().toISOString(), created_by: createdBy };
  await db
    .prepare("INSERT INTO agents (username, display_name, email, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
    .bind(agent.username, agent.display_name, agent.email, agent.created_at, agent.created_by)
    .run();
  return agent;
}

/** Refreshes display_name/email on every login, not just signup -- a provider's profile data (especially Cloudflare's, fetched via a second REST call) can be absent or wrong at signup time and correct itself later. Never clears a field the provider stops returning: only overwrites with a real, non-null value. */
export async function refreshAgentProfile(db: D1Database, username: string, displayName: string, email: string | null): Promise<void> {
  if (email) await db.prepare("UPDATE agents SET display_name = ?, email = ? WHERE username = ?").bind(displayName, email, username).run();
  else await db.prepare("UPDATE agents SET display_name = ? WHERE username = ?").bind(displayName, username).run();
}

export async function createAgentIdentity(db: D1Database, agentUsername: string, provider: string, providerSubject: string, tokens: { accessTokenEnc: string | null; refreshTokenEnc: string | null; expiresAt: string | null }): Promise<AgentIdentity> {
  const identity: AgentIdentity = {
    id: shortId("ident"),
    agent_username: agentUsername,
    provider: provider as "cloudflare" | "google",
    provider_subject: providerSubject,
    access_token_enc: tokens.accessTokenEnc,
    refresh_token_enc: tokens.refreshTokenEnc,
    token_expires_at: tokens.expiresAt,
    created_at: new Date().toISOString(),
  };
  await db
    .prepare("INSERT INTO agent_identities (id, agent_username, provider, provider_subject, access_token_enc, refresh_token_enc, token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(identity.id, identity.agent_username, identity.provider, identity.provider_subject, identity.access_token_enc, identity.refresh_token_enc, identity.token_expires_at, identity.created_at)
    .run();
  return identity;
}

export async function updateIdentityTokens(db: D1Database, identityId: string, tokens: { accessTokenEnc: string | null; refreshTokenEnc: string | null; expiresAt: string | null }): Promise<void> {
  await db
    .prepare("UPDATE agent_identities SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ? WHERE id = ?")
    .bind(tokens.accessTokenEnc, tokens.refreshTokenEnc, tokens.expiresAt, identityId)
    .run();
}

export async function createSession(db: D1Database, agentUsername: string, ttlSeconds: number): Promise<Session> {
  const now = Date.now();
  const session: Session = { id: shortId("sess"), agent_username: agentUsername, created_at: new Date(now).toISOString(), expires_at: new Date(now + ttlSeconds * 1000).toISOString() };
  await db.prepare("INSERT INTO sessions (id, agent_username, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(session.id, session.agent_username, session.created_at, session.expires_at).run();
  return session;
}

export async function getValidSession(db: D1Database, sessionId: string): Promise<Session | null> {
  const session = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first<Session>();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  return session;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

/** Agents this agent created -- provenance/display only (see Agent.created_by), never an access-control boundary. */
export async function listAgentsCreatedBy(db: D1Database, creatorUsername: string): Promise<Agent[]> {
  const result = await db.prepare("SELECT * FROM agents WHERE created_by = ? ORDER BY created_at DESC").bind(creatorUsername).all<Agent>();
  return result.results;
}

export async function createAgentToken(db: D1Database, agentUsername: string, tokenHash: string): Promise<AgentToken> {
  const token: AgentToken = { id: shortId("tok"), agent_username: agentUsername, token_hash: tokenHash, created_at: new Date().toISOString(), revoked_at: null, last_used_at: null };
  await db.prepare("INSERT INTO agent_tokens (id, agent_username, token_hash, created_at) VALUES (?, ?, ?, ?)").bind(token.id, token.agent_username, token.token_hash, token.created_at).run();
  return token;
}

export async function findActiveAgentToken(db: D1Database, tokenHash: string): Promise<AgentToken | null> {
  const token = await db.prepare("SELECT * FROM agent_tokens WHERE token_hash = ?").bind(tokenHash).first<AgentToken>();
  if (!token || token.revoked_at) return null;
  return token;
}

export async function touchAgentToken(db: D1Database, tokenId: string): Promise<void> {
  await db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), tokenId).run();
}

export async function revokeAgentToken(db: D1Database, tokenId: string): Promise<void> {
  await db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), tokenId).run();
}

export async function listTokensForAgent(db: D1Database, agentUsername: string): Promise<AgentToken[]> {
  const result = await db.prepare("SELECT * FROM agent_tokens WHERE agent_username = ? ORDER BY created_at DESC").bind(agentUsername).all<AgentToken>();
  return result.results;
}

/** The one thing doDeleteAgent (webApp.ts) refuses to cascade through automatically: another still-live agent it created. Everything else it owns or holds a Role on (shards, claims, Role grants) gets cleaned up or deleted as part of removing it -- see doDeleteAgent's own header comment. */
export async function agentsCreatedByStillExist(db: D1Database, username: string): Promise<string[]> {
  const created = await db.prepare("SELECT username FROM agents WHERE created_by = ?").bind(username).all<{ username: string }>();
  return created.results.map((r) => r.username);
}

/** Removes an agent's tokens/identities/sessions, then the agent row itself -- only once agentDeleteBlockers (webApp.ts's doDeleteAgent calls it first) comes back clean. */
export async function deleteAgent(db: D1Database, username: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM agent_tokens WHERE agent_username = ?").bind(username),
    db.prepare("DELETE FROM agent_identities WHERE agent_username = ?").bind(username),
    db.prepare("DELETE FROM sessions WHERE agent_username = ?").bind(username),
    db.prepare("DELETE FROM agents WHERE username = ?").bind(username),
  ]);
}

export async function getAgentToken(db: D1Database, tokenId: string): Promise<AgentToken | null> {
  return db.prepare("SELECT * FROM agent_tokens WHERE id = ?").bind(tokenId).first<AgentToken>();
}

export async function upsertRepo(db: D1Database, row: { slug: string; artifactsName: string; description: string | null; ownerUsername: string; shardOfSlug?: string | null }): Promise<RepoRow> {
  const existing = await db.prepare("SELECT * FROM repos WHERE slug = ?").bind(row.slug).first<RepoRow>();
  const now = new Date().toISOString();
  if (existing) {
    await db.prepare("UPDATE repos SET description = ?, updated_at = ? WHERE slug = ?").bind(row.description, now, existing.slug).run();
    return { ...existing, description: row.description, updated_at: now };
  }
  const repo: RepoRow = { slug: row.slug, artifacts_name: row.artifactsName, description: row.description, owner_username: row.ownerUsername, visibility: "public", shard_of_slug: row.shardOfSlug ?? null, created_at: now, updated_at: now };
  await db
    .prepare("INSERT INTO repos (slug, artifacts_name, description, owner_username, visibility, shard_of_slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(repo.slug, repo.artifacts_name, repo.description, repo.owner_username, repo.visibility, repo.shard_of_slug, repo.created_at, repo.updated_at)
    .run();
  return repo;
}

export async function getRepoBySlug(db: D1Database, slug: string): Promise<RepoRow | null> {
  return db.prepare("SELECT * FROM repos WHERE slug = ?").bind(slug).first<RepoRow>();
}

export async function updateRepoVisibility(db: D1Database, slug: string, visibility: "public" | "private"): Promise<void> {
  await db.prepare("UPDATE repos SET visibility = ? WHERE slug = ?").bind(visibility, slug).run();
}

/** Repoints a shard at a new parent, or (null) detaches it into a standalone repo -- webApp.ts's promoteShardAsNewOrigin, when an origin is deleted or made private while shards still exist. */
export async function updateRepoShardOf(db: D1Database, slug: string, shardOfSlug: string | null): Promise<void> {
  await db.prepare("UPDATE repos SET shard_of_slug = ? WHERE slug = ?").bind(shardOfSlug, slug).run();
}

export async function updateRepoDescription(db: D1Database, slug: string, description: string): Promise<void> {
  await db.prepare("UPDATE repos SET description = ? WHERE slug = ?").bind(description, slug).run();
}

export async function touchRepoUpdatedAt(db: D1Database, slug: string): Promise<void> {
  await db.prepare("UPDATE repos SET updated_at = ? WHERE slug = ?").bind(new Date().toISOString(), slug).run();
}

export async function setIngestStatus(db: D1Database, slug: string, status: "ready" | "ingesting"): Promise<void> {
  await db.prepare("UPDATE repos SET ingest_status = ? WHERE slug = ?").bind(status, slug).run();
}

// Every repo-listing query below takes `viewerUsername` (null for an
// anonymous visitor) and excludes private repos the viewer has no
// repo_roles grant on -- a private repo is invisible on /explore and
// search unless you're logged in AND have access, not just hidden from
// its own page (that gate already existed via canReadRepo; this closes
// the SAME gate for discovery, which previously ignored visibility
// entirely).
const VISIBILITY_CLAUSE = "(r.visibility = 'public' OR r.slug IN (SELECT repo_slug FROM repo_roles WHERE principal = ?))";

// A repo mid-import (ingest_status = 'ingesting') is still a real,
// readable repo -- its own page works, it's just not surfaced to
// strangers via search/listing while incomplete, the same way a
// private repo is readable by URL but not discoverable. The owner
// still sees their own mid-import repo in both places (so `zz repo
// list` after kicking off an import doesn't look like it silently
// vanished); everyone else sees it once it's 'ready'.
const INGEST_VISIBLE_CLAUSE = "(r.ingest_status = 'ready' OR r.owner_username = ?)";

export async function listRecentRepos(db: D1Database, limit: number, viewerUsername: string | null): Promise<RepoRow[]> {
  const result = await db
    .prepare(`SELECT * FROM repos r WHERE ${VISIBILITY_CLAUSE} AND ${INGEST_VISIBLE_CLAUSE} ORDER BY updated_at DESC LIMIT ?`)
    .bind(viewerUsername ?? "", viewerUsername ?? "", limit)
    .all<RepoRow>();
  return result.results;
}

export async function searchRepos(db: D1Database, query: string, limit: number, viewerUsername: string | null): Promise<RepoRow[]> {
  const like = `%${query}%`;
  const result = await db
    .prepare(
      `SELECT DISTINCT r.* FROM repos r
       LEFT JOIN agents a ON r.owner_username = a.username
       WHERE (r.slug LIKE ? OR r.description LIKE ? OR a.display_name LIKE ?) AND ${VISIBILITY_CLAUSE} AND ${INGEST_VISIBLE_CLAUSE}
       ORDER BY r.updated_at DESC LIMIT ?`,
    )
    .bind(like, like, like, viewerUsername ?? "", viewerUsername ?? "", limit)
    .all<RepoRow>();
  return result.results;
}

export interface ExploreResults {
  repos: RepoRow[];
  agents: Agent[];
  ladderHits: LadderSearchHit[];
}

/** The heterogeneous repo+agent+Ladder feed behind /explore -- same visibility rule as searchRepos throughout. Three distinct result TYPES, not one merged list: a repo match, a user match, and a Ladder match (a specific file/commit something was said about) are different enough things that the caller renders each its own way, not a single generic row shape. */
export async function searchExplore(db: D1Database, query: string, limit: number, viewerUsername: string | null): Promise<ExploreResults> {
  const [repos, agents, ladderHits] = await Promise.all([
    searchRepos(db, query, limit, viewerUsername),
    searchAgents(db, query, limit),
    // FTS5 MATCH has its own query syntax (quotes/parens/hyphens are
    // operators) -- a plain search box shouldn't 500 just because
    // someone typed a character that happens to mean something to FTS5,
    // so a malformed query degrades to "no Ladder hits" instead of
    // failing the whole /explore search.
    searchLadderIndex(db, query, limit, viewerUsername).catch(() => []),
  ]);
  return { repos, agents, ladderHits };
}

export async function listReposOwnedBy(db: D1Database, ownerUsername: string): Promise<RepoRow[]> {
  const result = await db.prepare("SELECT * FROM repos WHERE owner_username = ? ORDER BY updated_at DESC").bind(ownerUsername).all<RepoRow>();
  return result.results;
}

/** Direct (one level deep) shards of a repo -- webApp.ts's cleanup-shards flow walks this recursively itself to reach shards of shards, rather than this doing a recursive query. */
export async function listShardsOf(db: D1Database, parentSlug: string): Promise<RepoRow[]> {
  const result = await db.prepare("SELECT * FROM repos WHERE shard_of_slug = ? ORDER BY created_at ASC").bind(parentSlug).all<RepoRow>();
  return result.results;
}

/** `artifactsName` is needed because ladder_index is keyed by it, not by slug (see migration 0008's header) -- without clearing it here too, a deleted repo's Ladder search entries become permanent orphans: never cleaned up, never matching anything useful (the slug they'd join against no longer exists), just dead weight the FTS5 index has to scan past on every future search. Confirmed live: 90 of 98 rows in a real deployment's ladder_index were exactly this, from repos deleted over the course of one long session's testing. */
export async function deleteRepoRow(db: D1Database, slug: string, artifactsName: string): Promise<void> {
  await db.prepare("DELETE FROM repo_roles WHERE repo_slug = ?").bind(slug).run();
  await db.prepare("DELETE FROM repo_tracking WHERE repo_slug = ?").bind(slug).run();
  await db.prepare("DELETE FROM ladder_index WHERE artifacts_name = ?").bind(artifactsName).run();
  await db.prepare("DELETE FROM repos WHERE slug = ?").bind(slug).run();
}

export async function updateRepoOwner(db: D1Database, slug: string, ownerUsername: string): Promise<void> {
  await db.prepare("UPDATE repos SET owner_username = ?, updated_at = ? WHERE slug = ?").bind(ownerUsername, new Date().toISOString(), slug).run();
}

/** Agents matching a display name/email/username substring -- autocomplete for "who should this role/token belong to", searched across every Agent known to zz, not just ones you created. */
export async function searchAgents(db: D1Database, query: string, limit: number): Promise<Agent[]> {
  const like = `%${query}%`;
  const result = await db.prepare("SELECT * FROM agents WHERE display_name LIKE ? OR email LIKE ? OR username LIKE ? ORDER BY display_name LIMIT ?").bind(like, like, like, limit).all<Agent>();
  return result.results;
}

export interface RepoRoleRow {
  repo_slug: string;
  principal: string;
  role: string;
  granted_by: string;
  at: string;
}

/** Mirrors a repo's CURRENT full grant list (roles.json, the source of truth) into the D1 cache -- replace-all for that repo, so the cache can never drift into showing a grant that was since revoked. */
export async function syncRepoRoleCache(db: D1Database, slug: string, grants: { principal: string; role: string; granted_by: string; at: string }[]): Promise<void> {
  const writes: D1PreparedStatement[] = [db.prepare("DELETE FROM repo_roles WHERE repo_slug = ?").bind(slug)];
  for (const g of grants) {
    writes.push(db.prepare("INSERT INTO repo_roles (repo_slug, principal, role, granted_by, at) VALUES (?, ?, ?, ?, ?)").bind(slug, g.principal, g.role, g.granted_by, g.at));
  }
  await db.batch(writes);
}

/** A principal's own explicit Role grant on one repo, straight from the D1 cache (null if ungranted -- the caller decides what that means: "viewer" on a public repo, no access at all on a private one). Reads the cache rather than roles.json directly for the same reason listRepoRolesForAgent does: this runs on the hot path (every remote tool call, handleApiCallTool), where a live Artifacts round-trip per call would be a real cost, not just migration 0004's own cross-repo-scan concern. */
export async function getRepoRoleForPrincipal(db: D1Database, slug: string, principal: string): Promise<string | null> {
  const row = await db.prepare("SELECT role FROM repo_roles WHERE repo_slug = ? AND principal = ?").bind(slug, principal).first<{ role: string }>();
  return row?.role ?? null;
}

/** Repos (beyond ones owned outright) a principal has any repo-level Role grant on -- the profile page's "shared with you" list. Reads the D1 cache, not roles.json directly (see migration 0004's header for why a live cross-repo scan isn't affordable here). */
export async function listRepoRolesForAgent(db: D1Database, principal: string): Promise<(RepoRow & { role: string })[]> {
  const result = await db
    .prepare("SELECT r.*, rr.role as role FROM repo_roles rr JOIN repos r ON r.slug = rr.repo_slug WHERE rr.principal = ? AND r.owner_username != ? ORDER BY r.updated_at DESC")
    .bind(principal, principal)
    .all<RepoRow & { role: string }>();
  return result.results;
}

/** "Track this repo" -- a personal bookmark, not an RBAC grant (see migration 0011's header). Idempotent: tracking an already-tracked repo just refreshes tracked_at. */
export async function trackRepo(db: D1Database, username: string, slug: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO repo_tracking (username, repo_slug, tracked_at) VALUES (?, ?, ?)").bind(username, slug, new Date().toISOString()).run();
}

export async function untrackRepo(db: D1Database, username: string, slug: string): Promise<void> {
  await db.prepare("DELETE FROM repo_tracking WHERE username = ? AND repo_slug = ?").bind(username, slug).run();
}

export async function isTrackingRepo(db: D1Database, username: string, slug: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM repo_tracking WHERE username = ? AND repo_slug = ?").bind(username, slug).first();
  return row !== null;
}

/** Repos a principal is tracking (beyond ones owned or role-granted) -- see migration 0011's header. Excludes owned repos directly in SQL since there's no reason a repo would be in both tables for the same person in practice, but listMyRepos below still dedupes defensively against listRepoRolesForAgent too. */
async function listTrackedRepos(db: D1Database, username: string): Promise<RepoRow[]> {
  const result = await db
    .prepare("SELECT r.* FROM repo_tracking rt JOIN repos r ON r.slug = rt.repo_slug WHERE rt.username = ? AND r.owner_username != ? ORDER BY rt.tracked_at DESC")
    .bind(username, username)
    .all<RepoRow>();
  return result.results;
}

/** Every repo an agent "has" in some sense -- owned, role-granted, or just tracked -- merged into one role-sorted list (owner > coordinator > contributor > viewer), ties broken by most-recently-updated. The one function backing both the profile page's "Repos" card and GET /api/me/repos, so the merge/sort logic lives in exactly one place. */
export async function listMyRepos(db: D1Database, username: string): Promise<{ repo: RepoRow; role: RbacRole }[]> {
  const [owned, granted, tracked] = await Promise.all([listReposOwnedBy(db, username), listRepoRolesForAgent(db, username), listTrackedRepos(db, username)]);
  const bySlug = new Map<string, { repo: RepoRow; role: RbacRole }>();
  for (const repo of owned) bySlug.set(repo.slug, { repo, role: "owner" });
  for (const { role, ...repo } of granted) if (!bySlug.has(repo.slug)) bySlug.set(repo.slug, { repo, role: role as RbacRole });
  for (const repo of tracked) if (!bySlug.has(repo.slug)) bySlug.set(repo.slug, { repo, role: "viewer" });
  return [...bySlug.values()].sort((a, b) => RBAC_RANK[b.role] - RBAC_RANK[a.role] || (b.repo.updated_at < a.repo.updated_at ? -1 : 1));
}

// --- CLI login bridge: `zz login` opens a browser against the same
// OAuth flow the web app uses, then polls here for the token the
// callback mints once the human finishes logging in. Single-use,
// short-lived (the row is deleted once polled successfully) -- the
// nonce itself is the only secret standing between "pending" and
// "here's your token", so it has to be unguessable (crypto-random)
// and short-lived, same security shape as any OAuth authorization
// code.

export async function createCliLoginSession(db: D1Database, nonce: string): Promise<void> {
  await db.prepare("INSERT INTO cli_login_sessions (nonce, agent_username, token, created_at, consumed) VALUES (?, NULL, NULL, ?, 0)").bind(nonce, new Date().toISOString()).run();
}

export async function fulfillCliLoginSession(db: D1Database, nonce: string, agentUsername: string, token: string): Promise<boolean> {
  const result = await db.prepare("UPDATE cli_login_sessions SET agent_username = ?, token = ? WHERE nonce = ? AND consumed = 0").bind(agentUsername, token, nonce).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Returns the token once, then marks the session consumed so it can never be read again -- the whole point of the bridge is a one-time handoff. */
export async function pollAndConsumeCliLoginSession(db: D1Database, nonce: string): Promise<{ agentUsername: string; token: string } | null> {
  const row = await db.prepare("SELECT agent_username, token FROM cli_login_sessions WHERE nonce = ? AND consumed = 0").bind(nonce).first<{ agent_username: string | null; token: string | null }>();
  if (!row?.agent_username || !row.token) return null;
  await db.prepare("UPDATE cli_login_sessions SET consumed = 1 WHERE nonce = ?").bind(nonce).run();
  return { agentUsername: row.agent_username, token: row.token };
}

// --- Ladder search (migration 0008) ---
// "Ecosystem-wide intelligence" only matters if it's findable: this is
// the one cross-repo index over Ladder content (every other Ladder
// read is scoped to a single repo's own git notes). See
// cloudflareBackend.ts's writeLadder for the one place that calls
// indexLadderRung -- every rung write funnels through there regardless
// of caller, so this stays correct without touching call sites.

/** Delete-then-insert, not a real upsert -- FTS5 virtual tables have no unique constraint to upsert against, and rewriting the same (artifacts_name, path) is exactly what happens every time a file's rung gets a fresh holistic summary. `commitSha` is whatever commit this rung's current summary is anchored to (its most recent "commit" kind source) -- lets a search hit link to that commit, not just the file. */
export async function indexLadderRung(db: D1Database, artifactsName: string, path: string, kind: string, summary: string, commitSha: string | null): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM ladder_index WHERE artifacts_name = ? AND path = ?").bind(artifactsName, path),
    db.prepare("INSERT INTO ladder_index (artifacts_name, path, kind, commit_sha, summary) VALUES (?, ?, ?, ?, ?)").bind(artifactsName, path, kind, commitSha, summary),
  ]);
}

export interface LadderSearchHit {
  repo_slug: string;
  path: string;
  kind: string;
  commit_sha: string | null;
  summary: string;
}

/** BM25-ranked full-text search over every indexed rung's summary, joined back to the owning repo for its slug and gated by the same public-or-granted visibility rule as searchRepos. A `trap`-kind Insight (a documented mistake worth not repeating) outranks an equally-relevant ordinary summary -- ignoring a known trap should cost more than missing a routine note, so it has to actually surface first, not just exist somewhere in the results. SQLite's bm25() returns more-negative scores for a better match, ascending order already puts the best match first -- multiplying a trap's (negative) score by >1 makes it more negative, moving it earlier without needing a second ORDER BY clause. */
export async function searchLadderIndex(db: D1Database, query: string, limit: number, viewerUsername: string | null): Promise<LadderSearchHit[]> {
  // FTS5's MATCH argument is a query EXPRESSION, not a literal string --
  // an unquoted "." (any bare file path, e.g. "math.js"), "-", ":" or
  // similar is query syntax to it, not a token, and throws
  // "fts5: syntax error" (confirmed live, 2026-10-19, while verifying
  // #9's own ladder_search call on a path). Wrapping the whole query
  // in doubled quotes forces a plain phrase match -- safe for any
  // caller's input (a path, a symbol, a sentence), never a syntax
  // error, at the cost of losing FTS5's own AND/OR/prefix operators
  // for a caller that actually wanted them (none do today).
  const phraseQuery = `"${query.replace(/"/g, '""')}"`;
  const result = await db
    .prepare(
      `SELECT r.slug AS repo_slug, li.path, li.kind, li.commit_sha, li.summary
       FROM ladder_index li
       JOIN repos r ON r.artifacts_name = li.artifacts_name
       WHERE ladder_index MATCH ? AND ${VISIBILITY_CLAUSE}
       ORDER BY bm25(ladder_index) * (CASE WHEN li.kind = 'insight_trap' THEN 1.5 ELSE 1.0 END) LIMIT ?`,
    )
    .bind(phraseQuery, viewerUsername ?? "", limit)
    .all<LadderSearchHit>();
  return result.results;
}
