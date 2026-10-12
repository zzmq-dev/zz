// D1 query helpers for the unified agents/tokens/sessions/repos model
// -- see migrations/0002_unify_agents.sql for the schema and why
// there's one identity table, not an accounts-owns-agents hierarchy.
// repoMeta.ts's header covers why `repos` is an index/cache, not the
// source of truth (agents/tokens/sessions have no git home, so D1
// *is* authoritative for those).
import { randomBytes } from "node:crypto";

export interface Agent {
  id: string;
  display_name: string;
  email: string | null;
  created_at: string;
  created_by: string | null; // provenance only, never an authority relationship
}

export interface AgentIdentity {
  id: string;
  agent_id: string;
  provider: "cloudflare" | "google";
  provider_subject: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  created_at: string;
}

export interface AgentToken {
  id: string;
  agent_id: string;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface Session {
  id: string;
  agent_id: string;
  created_at: string;
  expires_at: string;
}

export interface RepoRow {
  id: string;
  slug: string;
  artifacts_name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface CliLoginSession {
  nonce: string;
  agent_id: string | null;
  token: string | null;
  created_at: string;
  consumed: number;
}

export function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export async function findAgentIdentity(db: D1Database, provider: string, providerSubject: string): Promise<AgentIdentity | null> {
  return db.prepare("SELECT * FROM agent_identities WHERE provider = ? AND provider_subject = ?").bind(provider, providerSubject).first<AgentIdentity>();
}

export async function getAgent(db: D1Database, id: string): Promise<Agent | null> {
  return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<Agent>();
}

export async function createAgent(db: D1Database, displayName: string, email: string | null, createdBy: string | null): Promise<Agent> {
  const agent: Agent = { id: shortId("agent"), display_name: displayName, email, created_at: new Date().toISOString(), created_by: createdBy };
  await db.prepare("INSERT INTO agents (id, display_name, email, created_at, created_by) VALUES (?, ?, ?, ?, ?)").bind(agent.id, agent.display_name, agent.email, agent.created_at, agent.created_by).run();
  return agent;
}

/** Refreshes display_name/email on every login, not just signup -- a provider's profile data (especially Cloudflare's, fetched via a second REST call) can be absent or wrong at signup time and correct itself later. Never clears a field the provider stops returning: only overwrites with a real, non-null value. */
export async function refreshAgentProfile(db: D1Database, agentId: string, displayName: string, email: string | null): Promise<void> {
  if (email) await db.prepare("UPDATE agents SET display_name = ?, email = ? WHERE id = ?").bind(displayName, email, agentId).run();
  else await db.prepare("UPDATE agents SET display_name = ? WHERE id = ?").bind(displayName, agentId).run();
}

export async function createAgentIdentity(db: D1Database, agentId: string, provider: string, providerSubject: string, tokens: { accessTokenEnc: string | null; refreshTokenEnc: string | null; expiresAt: string | null }): Promise<AgentIdentity> {
  const identity: AgentIdentity = {
    id: shortId("ident"),
    agent_id: agentId,
    provider: provider as "cloudflare" | "google",
    provider_subject: providerSubject,
    access_token_enc: tokens.accessTokenEnc,
    refresh_token_enc: tokens.refreshTokenEnc,
    token_expires_at: tokens.expiresAt,
    created_at: new Date().toISOString(),
  };
  await db
    .prepare("INSERT INTO agent_identities (id, agent_id, provider, provider_subject, access_token_enc, refresh_token_enc, token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(identity.id, identity.agent_id, identity.provider, identity.provider_subject, identity.access_token_enc, identity.refresh_token_enc, identity.token_expires_at, identity.created_at)
    .run();
  return identity;
}

export async function updateIdentityTokens(db: D1Database, identityId: string, tokens: { accessTokenEnc: string | null; refreshTokenEnc: string | null; expiresAt: string | null }): Promise<void> {
  await db
    .prepare("UPDATE agent_identities SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ? WHERE id = ?")
    .bind(tokens.accessTokenEnc, tokens.refreshTokenEnc, tokens.expiresAt, identityId)
    .run();
}

export async function createSession(db: D1Database, agentId: string, ttlSeconds: number): Promise<Session> {
  const now = Date.now();
  const session: Session = { id: shortId("sess"), agent_id: agentId, created_at: new Date(now).toISOString(), expires_at: new Date(now + ttlSeconds * 1000).toISOString() };
  await db.prepare("INSERT INTO sessions (id, agent_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(session.id, session.agent_id, session.created_at, session.expires_at).run();
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
export async function listAgentsCreatedBy(db: D1Database, creatorId: string): Promise<Agent[]> {
  const result = await db.prepare("SELECT * FROM agents WHERE created_by = ? ORDER BY created_at DESC").bind(creatorId).all<Agent>();
  return result.results;
}

export async function createAgentToken(db: D1Database, agentId: string, tokenHash: string): Promise<AgentToken> {
  const token: AgentToken = { id: shortId("tok"), agent_id: agentId, token_hash: tokenHash, created_at: new Date().toISOString(), revoked_at: null, last_used_at: null };
  await db.prepare("INSERT INTO agent_tokens (id, agent_id, token_hash, created_at) VALUES (?, ?, ?, ?)").bind(token.id, token.agent_id, token.token_hash, token.created_at).run();
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

export async function listTokensForAgent(db: D1Database, agentId: string): Promise<AgentToken[]> {
  const result = await db.prepare("SELECT * FROM agent_tokens WHERE agent_id = ? ORDER BY created_at DESC").bind(agentId).all<AgentToken>();
  return result.results;
}

export async function getAgentToken(db: D1Database, tokenId: string): Promise<AgentToken | null> {
  return db.prepare("SELECT * FROM agent_tokens WHERE id = ?").bind(tokenId).first<AgentToken>();
}

export async function upsertRepo(db: D1Database, row: { slug: string; artifactsName: string; description: string | null; ownerId: string }): Promise<RepoRow> {
  const existing = await db.prepare("SELECT * FROM repos WHERE slug = ?").bind(row.slug).first<RepoRow>();
  const now = new Date().toISOString();
  if (existing) {
    await db.prepare("UPDATE repos SET description = ?, updated_at = ? WHERE id = ?").bind(row.description, now, existing.id).run();
    return { ...existing, description: row.description, updated_at: now };
  }
  const repo: RepoRow = { id: shortId("repo"), slug: row.slug, artifacts_name: row.artifactsName, description: row.description, owner_id: row.ownerId, created_at: now, updated_at: now };
  await db
    .prepare("INSERT INTO repos (id, slug, artifacts_name, description, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(repo.id, repo.slug, repo.artifacts_name, repo.description, repo.owner_id, repo.created_at, repo.updated_at)
    .run();
  return repo;
}

export async function getRepoBySlug(db: D1Database, slug: string): Promise<RepoRow | null> {
  return db.prepare("SELECT * FROM repos WHERE slug = ?").bind(slug).first<RepoRow>();
}

export async function touchRepoUpdatedAt(db: D1Database, repoId: string): Promise<void> {
  await db.prepare("UPDATE repos SET updated_at = ? WHERE id = ?").bind(new Date().toISOString(), repoId).run();
}

export async function listRecentRepos(db: D1Database, limit: number): Promise<RepoRow[]> {
  const result = await db.prepare("SELECT * FROM repos ORDER BY updated_at DESC LIMIT ?").bind(limit).all<RepoRow>();
  return result.results;
}

export async function searchRepos(db: D1Database, query: string, limit: number): Promise<RepoRow[]> {
  const like = `%${query}%`;
  const result = await db
    .prepare(
      `SELECT DISTINCT r.* FROM repos r
       LEFT JOIN agents a ON r.owner_id = a.id
       WHERE r.slug LIKE ? OR r.description LIKE ? OR a.display_name LIKE ?
       ORDER BY r.updated_at DESC LIMIT ?`,
    )
    .bind(like, like, like, limit)
    .all<RepoRow>();
  return result.results;
}

export async function listReposOwnedBy(db: D1Database, ownerId: string): Promise<RepoRow[]> {
  const result = await db.prepare("SELECT * FROM repos WHERE owner_id = ? ORDER BY updated_at DESC").bind(ownerId).all<RepoRow>();
  return result.results;
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
  await db.prepare("INSERT INTO cli_login_sessions (nonce, agent_id, token, created_at, consumed) VALUES (?, NULL, NULL, ?, 0)").bind(nonce, new Date().toISOString()).run();
}

export async function fulfillCliLoginSession(db: D1Database, nonce: string, agentId: string, token: string): Promise<boolean> {
  const result = await db.prepare("UPDATE cli_login_sessions SET agent_id = ?, token = ? WHERE nonce = ? AND consumed = 0").bind(agentId, token, nonce).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Returns the token once, then marks the session consumed so it can never be read again -- the whole point of the bridge is a one-time handoff. */
export async function pollAndConsumeCliLoginSession(db: D1Database, nonce: string): Promise<{ agentId: string; token: string } | null> {
  const row = await db.prepare("SELECT agent_id, token FROM cli_login_sessions WHERE nonce = ? AND consumed = 0").bind(nonce).first<{ agent_id: string | null; token: string | null }>();
  if (!row?.agent_id || !row.token) return null;
  await db.prepare("UPDATE cli_login_sessions SET consumed = 1 WHERE nonce = ?").bind(nonce).run();
  return { agentId: row.agent_id, token: row.token };
}
