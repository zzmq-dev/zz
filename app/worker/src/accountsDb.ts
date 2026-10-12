// D1 query helpers for accounts/agents/tokens/sessions/repos -- see
// migrations/0001_accounts_rbac.sql for the schema and repoMeta.ts's
// header for why this is an index/cache, not the source of truth, for
// repo metadata specifically (accounts/agents/tokens have no git home,
// so D1 *is* authoritative for those).
import { randomBytes } from "node:crypto";

export interface Account {
  id: string;
  display_name: string;
  email: string | null;
  created_at: string;
}

export interface AccountIdentity {
  id: string;
  account_id: string;
  provider: "cloudflare" | "google";
  provider_subject: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  account_id: string;
  display_name: string;
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
  account_id: string;
  created_at: string;
  expires_at: string;
}

export interface RepoRow {
  id: string;
  slug: string;
  artifacts_name: string;
  description: string | null;
  owner_type: "account" | "agent";
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export async function findIdentity(db: D1Database, provider: string, providerSubject: string): Promise<AccountIdentity | null> {
  return db.prepare("SELECT * FROM account_identities WHERE provider = ? AND provider_subject = ?").bind(provider, providerSubject).first<AccountIdentity>();
}

export async function getAccount(db: D1Database, id: string): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
}

export async function createAccount(db: D1Database, displayName: string, email: string | null): Promise<Account> {
  const account: Account = { id: shortId("acct"), display_name: displayName, email, created_at: new Date().toISOString() };
  await db.prepare("INSERT INTO accounts (id, display_name, email, created_at) VALUES (?, ?, ?, ?)").bind(account.id, account.display_name, account.email, account.created_at).run();
  return account;
}

export async function createIdentity(db: D1Database, accountId: string, provider: string, providerSubject: string, tokens: { accessTokenEnc: string | null; refreshTokenEnc: string | null; expiresAt: string | null }): Promise<AccountIdentity> {
  const identity: AccountIdentity = {
    id: shortId("ident"),
    account_id: accountId,
    provider: provider as "cloudflare" | "google",
    provider_subject: providerSubject,
    access_token_enc: tokens.accessTokenEnc,
    refresh_token_enc: tokens.refreshTokenEnc,
    token_expires_at: tokens.expiresAt,
    created_at: new Date().toISOString(),
  };
  await db
    .prepare("INSERT INTO account_identities (id, account_id, provider, provider_subject, access_token_enc, refresh_token_enc, token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(identity.id, identity.account_id, identity.provider, identity.provider_subject, identity.access_token_enc, identity.refresh_token_enc, identity.token_expires_at, identity.created_at)
    .run();
  return identity;
}

export async function updateIdentityTokens(db: D1Database, identityId: string, tokens: { accessTokenEnc: string | null; refreshTokenEnc: string | null; expiresAt: string | null }): Promise<void> {
  await db
    .prepare("UPDATE account_identities SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ? WHERE id = ?")
    .bind(tokens.accessTokenEnc, tokens.refreshTokenEnc, tokens.expiresAt, identityId)
    .run();
}

export async function createSession(db: D1Database, accountId: string, ttlSeconds: number): Promise<Session> {
  const now = Date.now();
  const session: Session = { id: shortId("sess"), account_id: accountId, created_at: new Date(now).toISOString(), expires_at: new Date(now + ttlSeconds * 1000).toISOString() };
  await db.prepare("INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(session.id, session.account_id, session.created_at, session.expires_at).run();
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

export async function listAgentsForAccount(db: D1Database, accountId: string): Promise<Agent[]> {
  const result = await db.prepare("SELECT * FROM agents WHERE account_id = ? ORDER BY created_at DESC").bind(accountId).all<Agent>();
  return result.results;
}

export async function createAgent(db: D1Database, accountId: string, displayName: string): Promise<Agent> {
  const agent: Agent = { id: shortId("agent"), account_id: accountId, display_name: displayName, created_at: new Date().toISOString() };
  await db.prepare("INSERT INTO agents (id, account_id, display_name, created_at) VALUES (?, ?, ?, ?)").bind(agent.id, agent.account_id, agent.display_name, agent.created_at).run();
  return agent;
}

export async function getAgent(db: D1Database, id: string): Promise<Agent | null> {
  return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<Agent>();
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

export async function upsertRepo(db: D1Database, row: { slug: string; artifactsName: string; description: string | null; ownerType: "account" | "agent"; ownerId: string }): Promise<RepoRow> {
  const existing = await db.prepare("SELECT * FROM repos WHERE slug = ?").bind(row.slug).first<RepoRow>();
  const now = new Date().toISOString();
  if (existing) {
    await db.prepare("UPDATE repos SET description = ?, updated_at = ? WHERE id = ?").bind(row.description, now, existing.id).run();
    return { ...existing, description: row.description, updated_at: now };
  }
  const repo: RepoRow = { id: shortId("repo"), slug: row.slug, artifacts_name: row.artifactsName, description: row.description, owner_type: row.ownerType, owner_id: row.ownerId, created_at: now, updated_at: now };
  await db
    .prepare("INSERT INTO repos (id, slug, artifacts_name, description, owner_type, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(repo.id, repo.slug, repo.artifacts_name, repo.description, repo.owner_type, repo.owner_id, repo.created_at, repo.updated_at)
    .run();
  return repo;
}

export async function getRepoBySlug(db: D1Database, slug: string): Promise<RepoRow | null> {
  return db.prepare("SELECT * FROM repos WHERE slug = ?").bind(slug).first<RepoRow>();
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
       LEFT JOIN accounts a ON r.owner_type = 'account' AND r.owner_id = a.id
       LEFT JOIN agents g ON r.owner_type = 'agent' AND r.owner_id = g.id
       WHERE r.slug LIKE ? OR r.description LIKE ? OR a.display_name LIKE ? OR g.display_name LIKE ?
       ORDER BY r.updated_at DESC LIMIT ?`,
    )
    .bind(like, like, like, like, limit)
    .all<RepoRow>();
  return result.results;
}

export async function listReposOwnedBy(db: D1Database, ownerType: "account" | "agent", ownerId: string): Promise<RepoRow[]> {
  const result = await db.prepare("SELECT * FROM repos WHERE owner_type = ? AND owner_id = ? ORDER BY updated_at DESC").bind(ownerType, ownerId).all<RepoRow>();
  return result.results;
}
