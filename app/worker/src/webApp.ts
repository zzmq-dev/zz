// The public web app: explore/search, a GitHub-like repo page, login
// (Cloudflare + Google OAuth), a profile page, and a JSON /api/* layer
// so the CLI (`zz login`, `zz agent`, `zz repo`) has full parity with
// the web UI -- everything doable in the browser is doable from a
// terminal or by an agent with no browser at all. Added as routes on
// the existing zz-maintainer Worker rather than a second service,
// given the time budget (see the approved plan).
//
// One identity model throughout: there is no "account" distinct from
// "agent" -- per governance.md, every participant, human or
// synthetic, is an Agent, and none is inherently superior to another.
// `created_by` is provenance for the profile page's display only,
// never an authority relationship; all real authority is a repo-level
// Role grant (roles.json on that repo's zz-meta branch), the same
// mechanism for every Agent.
//
// Every self-referential link uses `new URL(request.url).origin`,
// never a hardcoded domain -- the domain (zzbin.dev today) can change
// with zero code changes here; only the OAuth redirect URIs (Worker
// vars) need updating alongside a Dashboard change.
import { zipSync } from "fflate";
import { createInitialCommit } from "./cloudflareGitBackend.js";
import type { MaintainerDO } from "./MaintainerDO.js";
// Artifacts/ArtifactsRepo are ambient globals from @cloudflare/workers-types
// (no import needed/possible -- see cloudflareGitBackend.ts's header for
// why a module-level import of these resolves wrong).
import {
  type Agent,
  type RepoRow,
  createAgent,
  createAgentIdentity,
  createAgentToken,
  createCliLoginSession,
  createSession,
  deleteSession,
  findActiveAgentToken,
  findAgentIdentity,
  fulfillCliLoginSession,
  getAgent,
  getAgentToken,
  getRepoBySlug,
  getValidSession,
  listAgentsCreatedBy,
  listRecentRepos,
  listReposOwnedBy,
  listTokensForAgent,
  pollAndConsumeCliLoginSession,
  refreshAgentProfile,
  revokeAgentToken,
  searchRepos,
  shortId,
  touchAgentToken,
  touchRepoUpdatedAt,
  updateIdentityTokens,
  upsertRepo,
} from "./accountsDb.js";
import {
  buildAuthorizeUrl,
  clearSessionCookieHeader,
  decryptSecret,
  encryptSecret,
  exchangeCodeForIdentity,
  generateAgentToken,
  hashAgentToken,
  readBearerToken,
  readSessionCookie,
  sessionCookieHeader,
  type OAuthEnv,
  type Provider,
} from "./auth.js";
import { ensureMeta, readRepoMeta, readRepoRoles, repoAtLeast, repoRoleFor, writeRepoRoles, type RbacRole } from "./repoMeta.js";

export interface WebEnv extends OAuthEnv {
  ARTIFACTS: Artifacts;
  DB: D1Database;
  MAINTAINER_DO: DurableObjectNamespace<MaintainerDO>;
}

// --- HTML helpers ---

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function layout(title: string, agent: Agent | null, body: string, opts: { cookies?: string[] } = {}): Response {
  const nav = agent
    ? `<a href="/explore">Explore</a> · <a href="/profile">${esc(agent.display_name)}</a> · <a href="/logout">Log out</a>`
    : `<a href="/explore">Explore</a> · <a href="/login">Log in</a>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - zz</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:0 auto;padding:1.5rem;color:#1a1a1a;background:#fff}
nav{margin-bottom:1.5rem;font-size:.9rem}
a{color:#0969da;text-decoration:none} a:hover{text-decoration:underline}
.repo-list li{margin-bottom:.75rem;list-style:none}
.repo-list{padding:0}
.muted{color:#666;font-size:.9rem}
table{border-collapse:collapse;width:100%} td,th{padding:.4rem;border-bottom:1px solid #eee;text-align:left}
pre{background:#f6f8fa;padding:.75rem;border-radius:6px;overflow-x:auto}
input,button,select,textarea{font-size:1rem;padding:.4rem;margin:.2rem 0}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:1rem;background:#eee;font-size:.8rem}
form{margin:1rem 0}
</style></head><body>
<nav>${nav}</nav>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const cookie of opts.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(html, { headers });
}

// Takes `cookies` as a real array, appended individually -- joining
// multiple Set-Cookie values with ", " into one header line is NOT
// valid (unlike most headers, Set-Cookie can't be comma-combined;
// cookie values can contain commas themselves). Confirmed live: doing
// that once silently dropped everything but the first cookie, which
// broke zz_cli_nonce riding alongside zz_oauth_state.
function redirect(url: string, opts: { cookies?: string[] } = {}): Response {
  const headers = new Headers({ location: url });
  for (const cookie of opts.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- Auth ---

/** Session cookie (browser) OR bearer token (CLI, bots, git -- see resolveGitAuthPrincipal) -- same identity model either way, just two ways to present a credential for the same kind of entity. */
async function resolveRequestAgent(request: Request, env: WebEnv): Promise<Agent | null> {
  const sessionId = readSessionCookie(request);
  if (sessionId) {
    const session = await getValidSession(env.DB, sessionId);
    if (session) return getAgent(env.DB, session.agent_id);
  }
  const bearer = readBearerToken(request);
  if (bearer) {
    const token = await findActiveAgentToken(env.DB, hashAgentToken(bearer));
    if (token) {
      await touchAgentToken(env.DB, token.id);
      return getAgent(env.DB, token.agent_id);
    }
  }
  return null;
}

async function handleLogin(request: Request): Promise<Response> {
  const cliNonce = new URL(request.url).searchParams.get("cli_nonce") ?? "";
  const qs = cliNonce ? `?cli_nonce=${encodeURIComponent(cliNonce)}` : "";
  return layout(
    "Log in",
    null,
    `${cliNonce ? '<p class="muted">Logging in for the zz CLI -- this browser tab can be closed once it redirects back.</p>' : ""}
     <p><a href="/auth/start/cloudflare${qs}"><button>Log in with Cloudflare</button></a></p>
     <p><a href="/auth/start/google${qs}"><button>Log in with Google</button></a></p>`,
  );
}

async function handleAuthStart(provider: Provider, request: Request, env: WebEnv): Promise<Response> {
  const cliNonce = new URL(request.url).searchParams.get("cli_nonce") ?? "";
  const state = shortId("state");
  const url = buildAuthorizeUrl(provider, env, state);
  const cookies = [`zz_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`];
  if (cliNonce) cookies.push(`zz_cli_nonce=${cliNonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  return redirect(url, { cookies });
}

async function handleAuthCallback(provider: Provider, request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieState = cookieHeader.match(/zz_oauth_state=([^;]+)/)?.[1];
  const cliNonce = cookieHeader.match(/zz_cli_nonce=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) {
    return new Response("OAuth state mismatch or missing code -- please try logging in again.", { status: 400 });
  }

  const identity = await exchangeCodeForIdentity(provider, env, code);
  const existing = await findAgentIdentity(env.DB, provider, identity.subject);
  const expiresAt = identity.expiresInSeconds ? new Date(Date.now() + identity.expiresInSeconds * 1000).toISOString() : null;
  const accessTokenEnc = await encryptSecret(env, identity.accessToken);
  const refreshTokenEnc = identity.refreshToken ? await encryptSecret(env, identity.refreshToken) : null;

  let agent: Agent;
  if (existing) {
    agent = (await getAgent(env.DB, existing.agent_id))!;
    await updateIdentityTokens(env.DB, existing.id, { accessTokenEnc, refreshTokenEnc, expiresAt });
    await refreshAgentProfile(env.DB, agent.id, identity.displayName, identity.email);
  } else {
    agent = await createAgent(env.DB, identity.displayName, identity.email, null);
    await createAgentIdentity(env.DB, agent.id, provider, identity.subject, { accessTokenEnc, refreshTokenEnc, expiresAt });
  }

  const session = await createSession(env.DB, agent.id, 60 * 60 * 24 * 30);

  // CLI bridge: a `zz login` browser tab carries a nonce through as a
  // cookie; fulfill it with a fresh bearer token so the waiting CLI
  // process can pick it up on its next poll. The web session above is
  // independent -- this tab also ends up logged in normally if left open.
  if (cliNonce) {
    const plaintext = generateAgentToken();
    await createAgentToken(env.DB, agent.id, hashAgentToken(plaintext));
    const fulfilled = await fulfillCliLoginSession(env.DB, cliNonce, agent.id, plaintext);
    if (fulfilled) {
      return layout(
        "Logged in",
        agent,
        `<p>Logged in as <b>${esc(agent.display_name)}</b>. You can close this tab and return to your terminal.</p>`,
      );
    }
  }

  // First-ever browser login, no CLI involved: mint a token right
  // here too, same reasoning as doCreateAgent -- a credential that's
  // only ever issued from a buried "issue yourself a token" button on
  // /profile is a credential most people won't find until they
  // already need it (confirmed live: git push failure asking "how do
  // I even get a token"). Only on first login (zero existing active
  // tokens) -- a token is shown-once by design, so minting one on
  // every return visit would just produce unusable, never-seen tokens.
  const existingTokens = (await listTokensForAgent(env.DB, agent.id)).filter((t) => !t.revoked_at);
  if (existingTokens.length === 0) {
    const plaintext = generateAgentToken();
    await createAgentToken(env.DB, agent.id, hashAgentToken(plaintext));
    return layout(
      "Welcome",
      agent,
      `<p>Logged in as <b>${esc(agent.display_name)}</b>. Here's a token for \`git push\`, the CLI, or any script acting as you -- copy it now, it won't be shown again:</p>
       <pre>${esc(plaintext)}</pre>
       <p><a href="/profile">Continue to your profile</a></p>`,
      { cookies: [sessionCookieHeader(session.id, 60 * 60 * 24 * 30)] },
    );
  }

  return redirect("/profile", { cookies: [sessionCookieHeader(session.id, 60 * 60 * 24 * 30)] });
}

async function handleLogout(request: Request, env: WebEnv): Promise<Response> {
  const sessionId = readSessionCookie(request);
  if (sessionId) await deleteSession(env.DB, sessionId);
  return redirect("/explore", { cookies: [clearSessionCookieHeader()] });
}

// --- CLI login bridge (JSON) ---

async function handleApiLoginStart(request: Request, env: WebEnv): Promise<Response> {
  const nonce = shortId("nonce");
  await createCliLoginSession(env.DB, nonce);
  const origin = new URL(request.url).origin;
  return json({ nonce, url: `${origin}/login?cli_nonce=${nonce}` });
}

async function handleApiLoginPoll(request: Request, env: WebEnv): Promise<Response> {
  const nonce = new URL(request.url).searchParams.get("nonce");
  if (!nonce) return json({ error: "missing ?nonce=" }, 400);
  const result = await pollAndConsumeCliLoginSession(env.DB, nonce);
  if (!result) return json({ status: "pending" });
  const agent = await getAgent(env.DB, result.agentId);
  return json({ status: "ready", token: result.token, agent: { id: result.agentId, display_name: agent?.display_name ?? result.agentId } });
}

// --- Shared core logic (used by both HTML forms and the JSON API) ---

// Issues the agent's first credential as part of creation itself,
// not a separate click -- there's no reason to make "spin up an Agent
// and get it a usable token" a two-step dance when both steps happen
// in the same request anyway. Issuing an *additional* token later
// (rotation, a second credential for a second machine/process) stays
// its own explicit action -- see doMintToken.
async function doCreateAgent(env: WebEnv, creator: Agent, displayName: string): Promise<{ agent: Agent; token: string }> {
  if (!displayName.trim()) throw new ApiError(400, "display_name is required");
  const agent = await createAgent(env.DB, displayName.trim(), null, creator.id);
  const token = generateAgentToken();
  await createAgentToken(env.DB, agent.id, hashAgentToken(token));
  return { agent, token };
}

/** Minting a token for an agent is allowed for the agent itself (re-authenticating with an existing token/session) or whoever created it -- a practical bootstrap allowance (a brand-new agent has no credential yet, so someone has to issue its first one), not a general override. */
async function requireTokenMintAuthority(env: WebEnv, actor: Agent, targetAgentId: string): Promise<Agent> {
  const target = await getAgent(env.DB, targetAgentId);
  if (!target) throw new ApiError(404, "no such agent");
  if (target.id !== actor.id && target.created_by !== actor.id) throw new ApiError(403, "you can only mint tokens for yourself or an agent you created");
  return target;
}

async function doMintToken(env: WebEnv, actor: Agent, targetAgentId: string): Promise<{ agent: Agent; token: string }> {
  const target = await requireTokenMintAuthority(env, actor, targetAgentId);
  const plaintext = generateAgentToken();
  await createAgentToken(env.DB, target.id, hashAgentToken(plaintext));
  return { agent: target, token: plaintext };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/** The repo URL's owner segment: an Agent's real email if it has one (literal, not slugified -- per direct instruction), else a slugified display name. Driven by data (does this Agent have an email?), not by a type tag -- there is no "human vs bot" branch here, any Agent could plausibly have an email if it ever links an OAuth identity. */
function ownerUrlSegment(agent: Agent): string {
  return agent.email ?? slugify(agent.display_name);
}

async function doCreateRepo(env: WebEnv, owner: Agent, name: string, description: string | null): Promise<RepoRow> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ApiError(400, "repo name must match [A-Za-z0-9._-]+");
  const artifactsName = shortId("repo");
  const slug = `${ownerUrlSegment(owner)}/${slugify(name)}`;

  const created = await env.ARTIFACTS.create(artifactsName, { description: description ?? undefined, setDefaultBranch: "main" });
  using repo = await env.ARTIFACTS.get(artifactsName);
  const token = await repo.createToken("write", 3600);
  // commit_changeset (and anything else that anchors to a commit) needs
  // a parent to diff against -- a brand new repo has none, so seed one.
  await createInitialCommit(created.remote, token, [{ path: "README.md", content: `# ${name}\n\n${description ?? ""}\n` }], { name: owner.display_name, email: owner.email ?? `${owner.id}@zz.local` });
  await ensureMeta(created.remote, token, { description: description ?? "", ownerId: owner.id });
  return upsertRepo(env.DB, { slug, artifactsName, description, ownerId: owner.id });
}

async function doRbacGrant(env: WebEnv, actor: Agent, repoSlug: string, principal: string, role: RbacRole): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such repo");

  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("write", 3600);
  const info = await artifactsRepo.info();

  const roles = await readRepoRoles(info.remote, token);
  // No more "or any agent I created" indirection -- peers means the
  // ACTOR's own standing is what's checked, full stop, same as every
  // other RBAC check in this codebase (canReadRepo/canPushRepo).
  if (!repoAtLeast(repoRoleFor(roles, actor.id), "owner")) throw new ApiError(403, `${actor.id} is not an Owner of ${repoSlug}`);

  const nextGrants = (roles?.grants ?? []).filter((g) => g.principal !== principal);
  nextGrants.push({ principal, role, granted_by: actor.id, at: new Date().toISOString() });
  await writeRepoRoles(info.remote, token, { grants: nextGrants });
}

interface LaneHistoryEntry {
  id?: string;
  type: "ASK" | "ANSWER" | "INSIGHT";
  kind?: string;
  from?: string;
  action?: string;
  ask?: string;
  payload?: unknown;
  at: string;
}

interface LaneSnapshot {
  id: string;
  status: string;
  history: LaneHistoryEntry[];
}

/** The root ("_repo") Lane's full history -- every ASK/ANSWER posted via doPostAsk or the engine's own protocol, the only place this is currently visible (there's no dedicated Ladder/Lane viewer page yet). Null if the repo has no root Lane yet (never had an Ask posted to it). */
async function getRootLane(env: WebEnv, artifactsName: string): Promise<LaneSnapshot | null> {
  const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(artifactsName));
  await stub.configure(artifactsName);
  return (await stub.callTool("lane_get", { repo: artifactsName, lane_id: "_repo" })) as LaneSnapshot | null;
}

async function doPostAsk(env: WebEnv, actor: Agent, repoSlug: string, description: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such repo");
  const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(repo.artifacts_name));
  await stub.configure(repo.artifacts_name);
  // The "_repo" root Lane isn't the same thing as the Ladder's "_repo"
  // root rung (ensureMeta/writeRung territory) -- it's a real Lane,
  // which doCreateRepo never bootstrapped (confirmed live: posting an
  // ask to a repo created through the web/API threw "no such lane:
  // _repo"). Lazily create it here, the same bootstrap
  // demo/greenfield.ts's local flow always did, so this self-heals for
  // every repo already created before this fix too, not just new ones.
  const existingLane = await stub.callTool("lane_get", { repo: repo.artifacts_name, lane_id: "_repo" });
  if (!existingLane) {
    await stub.callTool("lane_propose", { repo: repo.artifacts_name, id: "_repo", name: repo.slug, objective: `the ${repo.slug} repository`, scope: ["**"], actor: repo.owner_id });
  }
  await stub.callTool("ask_post", { repo: repo.artifacts_name, lane_id: "_repo", kind: "work", from: actor.id, payload: { description } });
}

// --- Profile (HTML) ---

async function handleProfile(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");

  const createdAgents = await listAgentsCreatedBy(env.DB, me.id);
  const allSelf = [me, ...createdAgents];
  const repoLists = await Promise.all(allSelf.map((a) => listReposOwnedBy(env.DB, a.id)));
  const tokenLists = await Promise.all(createdAgents.map((a) => listTokensForAgent(env.DB, a.id)));
  const myTokens = (await listTokensForAgent(env.DB, me.id)).filter((t) => !t.revoked_at);

  const agentsHtml = createdAgents
    .map((a, i) => {
      const tokens = tokenLists[i].filter((t) => !t.revoked_at);
      const repos = repoLists[i + 1];
      return `<li><b>${esc(a.display_name)}</b> <span class="muted">(${a.id})</span>
        <form method="post" action="/profile/agents/${a.id}/tokens" style="display:inline">
          <button type="submit">Issue another token</button>
        </form>
        <ul>${tokens.map((t) => `<li>token ${t.id} created ${esc(t.created_at)} ${t.last_used_at ? `last used ${esc(t.last_used_at)}` : "(never used)"} <form method="post" action="/profile/tokens/${t.id}/revoke" style="display:inline"><button type="submit">Revoke</button></form></li>`).join("")}</ul>
        <div class="muted">Repos: ${repos.length ? repos.map((r) => `<a href="/${esc(r.slug)}">${esc(r.slug)}</a>`).join(", ") : "none"}</div>
      </li>`;
    })
    .join("");

  const allRepos = repoLists.flat();

  return layout(
    "Profile",
    me,
    `<p>${esc(me.display_name)} ${me.email ? `&lt;${esc(me.email)}&gt;` : ""}</p>
     <p class="muted">Your own tokens: ${myTokens.length ? myTokens.map((t) => `${t.id}${t.last_used_at ? ` (last used ${esc(t.last_used_at)})` : " (never used)"}`).join(", ") : "none"}
       <form method="post" action="/profile/agents/${me.id}/tokens" style="display:inline"><button type="submit">Issue yourself a token</button></form>
       -- for \`git push\`, the CLI, or any script acting directly as you. Use it as the username (password blank) when git prompts for credentials.</p>

     <h2>Managed agents</h2>
     <p class="muted">Agents whose credentials you can issue, rotate, or revoke -- not "yours" in the sense of owning their actions, just the one accountable for their access, same as any API credential you'd manage.</p>
     <form method="post" action="/profile/agents">
       <input name="display_name" placeholder="agent name" required>
       <button type="submit">Create agent</button>
     </form>
     <ul>${agentsHtml || "<li class=\"muted\">None yet.</li>"}</ul>

     <h2>Your repos</h2>
     <ul>${repoLists[0].map((r) => `<li><a href="/${esc(r.slug)}">${esc(r.slug)}</a></li>`).join("") || "<li class=\"muted\">None owned directly (check your agents above).</li>"}</ul>

     <h2>Grant/revoke a repo Role</h2>
     <form method="post" action="/profile/rbac">
       <select name="repo_slug">${allRepos.map((r) => `<option value="${esc(r.slug)}">${esc(r.slug)}</option>`).join("")}</select>
       <input name="principal" placeholder="agent id (yours, or any other Agent's)" required>
       <select name="role"><option>owner</option><option>maintainer</option><option selected>contributor</option><option>reader</option></select>
       <button type="submit">Grant</button>
     </form>

     <h2>Create a repo</h2>
     <form method="post" action="/profile/repos">
       <select name="owner_id">
         <option value="${esc(me.id)}">${esc(me.display_name)} (you)</option>
         ${createdAgents.map((a) => `<option value="${esc(a.id)}">${esc(a.display_name)}</option>`).join("")}
       </select>
       <input name="name" placeholder="repo-name" required pattern="[A-Za-z0-9._-]+">
       <input name="description" placeholder="description">
       <button type="submit">Create</button>
     </form>

     <h2>Post an ASK to a repo's root Lane</h2>
     <form method="post" action="/profile/ask">
       <input name="repo_slug" placeholder="owner/repo-name" required>
       <textarea name="description" placeholder="what do you need done?" required></textarea>
       <button type="submit">Post ASK</button>
     </form>`,
  );
}

async function handleCreateAgentForm(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    const { agent, token } = await doCreateAgent(env, me, String(form.get("display_name") ?? ""));
    return layout(
      "Agent created",
      me,
      `<p>Created <b>${esc(agent.display_name)}</b> (${esc(agent.id)}). Its first token -- copy it now, it won't be shown again:</p>
       <pre>${esc(token)}</pre>
       <p><a href="/profile">Back to profile</a></p>`,
    );
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
}

async function handleMintTokenForm(agentId: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  try {
    const { agent, token } = await doMintToken(env, me, agentId);
    return layout(
      "New agent token",
      me,
      `<p>Token for <b>${esc(agent.display_name)}</b> -- copy it now, it won't be shown again:</p>
       <pre>${esc(token)}</pre>
       <p><a href="/profile">Back to profile</a></p>`,
    );
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
}

async function handleRevokeTokenForm(tokenId: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const token = await getAgentToken(env.DB, tokenId);
  if (token) {
    const owner = await getAgent(env.DB, token.agent_id);
    if (owner && (owner.id === me.id || owner.created_by === me.id)) await revokeAgentToken(env.DB, tokenId);
  }
  return redirect("/profile");
}

async function handleRbacGrantForm(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    await doRbacGrant(env, me, String(form.get("repo_slug") ?? ""), String(form.get("principal") ?? ""), String(form.get("role") ?? "reader") as RbacRole);
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
  return redirect("/profile");
}

async function handleCreateRepoForm(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  const ownerId = String(form.get("owner_id") ?? "");
  const owner = ownerId === me.id ? me : await getAgent(env.DB, ownerId);
  if (!owner || (owner.id !== me.id && owner.created_by !== me.id)) return new Response("not yours to create repos as", { status: 403 });
  try {
    const repo = await doCreateRepo(env, owner, String(form.get("name") ?? "").trim(), String(form.get("description") ?? "").trim() || null);
    return redirect(`/${repo.slug}`);
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
}

async function handleAskForm(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    await doPostAsk(env, me, String(form.get("repo_slug") ?? ""), String(form.get("description") ?? ""));
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
  return redirect("/profile");
}

// --- JSON API (same core logic, bearer-token or session authenticated, for the CLI and any script) ---

async function requireApiAgent(request: Request, env: WebEnv): Promise<Agent> {
  const agent = await resolveRequestAgent(request, env);
  if (!agent) throw new ApiError(401, "authentication required (Authorization: Bearer <token>)");
  return agent;
}

async function withApi(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    throw err;
  }
}

async function handleApiMe(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => json(await requireApiAgent(request, env)));
}

async function handleApiCreateAgent(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { display_name?: string };
    const { agent, token } = await doCreateAgent(env, me, body.display_name ?? "");
    return json({ ...agent, token }, 201);
  });
}

async function handleApiListAgents(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    return json({ you: me, created: await listAgentsCreatedBy(env.DB, me.id) });
  });
}

async function handleApiMintToken(agentId: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const { agent, token } = await doMintToken(env, me, agentId);
    return json({ agent, token }, 201);
  });
}

async function handleApiCreateRepo(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { name?: string; description?: string; owner_id?: string };
    const owner = !body.owner_id || body.owner_id === me.id ? me : await getAgent(env.DB, body.owner_id);
    if (!owner || (owner.id !== me.id && owner.created_by !== me.id)) throw new ApiError(403, "not yours to create repos as");
    const repo = await doCreateRepo(env, owner, (body.name ?? "").trim(), body.description?.trim() || null);
    return json(repo, 201);
  });
}

async function handleApiListRepos(request: Request, env: WebEnv): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const repos = q ? await searchRepos(env.DB, q, 50) : await listRecentRepos(env.DB, 50);
  return json({ repos });
}

async function handleApiGetRepo(slug: string, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const ctx = await getRepoAccessContext(slug, env);
    if (!ctx) throw new ApiError(404, "no such repo");
    return json({ repo: ctx.repoRow, meta: ctx.meta, roles: ctx.roles });
  });
}

async function handleApiGetAsks(slug: string, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const ctx = await getRepoAccessContext(slug, env);
    if (!ctx) throw new ApiError(404, "no such repo");
    const lane = await getRootLane(env, ctx.repoRow.artifacts_name);
    return json({ lane });
  });
}

async function handleApiRbacGrant(slug: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { principal?: string; role?: RbacRole };
    if (!body.principal || !body.role) throw new ApiError(400, "principal and role are required");
    await doRbacGrant(env, me, slug, body.principal, body.role);
    return json({ ok: true });
  });
}

async function handleApiPostAsk(slug: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { description?: string };
    if (!body.description) throw new ApiError(400, "description is required");
    await doPostAsk(env, me, slug, body.description);
    return json({ ok: true });
  });
}

// --- Explore (list + search, one route) ---

async function handleExplore(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const repos = q ? await searchRepos(env.DB, q, 50) : await listRecentRepos(env.DB, 50);

  const listHtml = repos
    .map((r) => `<li><a href="/${esc(r.slug)}">${esc(r.slug)}</a>${r.description ? ` <span class="muted">- ${esc(r.description)}</span>` : ""}</li>`)
    .join("");

  return layout(
    "Explore",
    me,
    `<form method="get" action="/explore">
       <input name="q" value="${esc(q)}" placeholder="search repos, owners, descriptions" style="width:60%">
       <button type="submit">Search</button>
     </form>
     <ul class="repo-list">${listHtml || `<li class="muted">${q ? "No matches." : "No repos yet."}</li>`}</ul>`,
  );
}

// --- Repo page ---

interface TreeEntry {
  name: string;
  hash: string;
  type: string;
  mode: string;
}

async function findReadme(repo: ArtifactsRepo, tree: TreeEntry[]): Promise<string | null> {
  const entry = tree.find((e) => /^readme(\.md)?$/i.test(e.name));
  if (!entry) return null;
  const blob = await repo.readBlob(entry.hash);
  return blob ? blob.text() : null;
}

async function walkTreeForZip(repo: ArtifactsRepo, treeHash: string, prefix: string, out: Record<string, Uint8Array>): Promise<void> {
  const entries = (await repo.readTree(treeHash)) ?? [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === "tree") {
      await walkTreeForZip(repo, entry.hash, path, out);
    } else {
      const blob = await repo.readBlob(entry.hash);
      if (blob) out[path] = new Uint8Array(await blob.arrayBuffer());
    }
  }
}

// Loads what every read path needs to decide access + render: the D1
// row plus meta.json/roles.json off zz-meta. A second, separate
// `env.ARTIFACTS.get()` happens in each handler afterward for the
// actual content read -- an extra token mint per request, traded for
// every read path (page, blob, archive, the git proxy below) sharing
// one access-control check instead of several that could drift out
// of sync.
async function getRepoAccessContext(slug: string, env: WebEnv): Promise<{ repoRow: RepoRow; meta: Awaited<ReturnType<typeof readRepoMeta>>; roles: Awaited<ReturnType<typeof readRepoRoles>> } | null> {
  const repoRow = await getRepoBySlug(env.DB, slug);
  if (!repoRow) return null;
  using repo = await env.ARTIFACTS.get(repoRow.artifacts_name);
  const token = await repo.createToken("read", 300);
  const info = await repo.info();
  await ensureMeta(info.remote, token, { description: repoRow.description ?? "", ownerId: repoRow.owner_id });
  const [meta, roles] = await Promise.all([readRepoMeta(info.remote, token), readRepoRoles(info.remote, token)]);
  return { repoRow, meta, roles };
}

// Git has no session cookie -- it authenticates over Basic Auth on
// the smart-HTTP request itself, resolving to the same bearer-token
// path the JSON API uses (requireApiAgent/resolveRequestAgent), just
// read from the Basic Auth slot instead of an Authorization: Bearer
// header. GitHub's own convention is the token as username with a
// blank password, so that's checked first, but either slot works here.
function parseBasicAuth(request: Request): { username: string; password: string } | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

async function resolveGitAuthPrincipal(request: Request, env: WebEnv): Promise<string | null> {
  const basic = parseBasicAuth(request);
  if (!basic) return null;
  const candidate = basic.username || basic.password;
  if (!candidate) return null;
  const token = await findActiveAgentToken(env.DB, hashAgentToken(candidate));
  if (!token) return null;
  await touchAgentToken(env.DB, token.id);
  return token.agent_id;
}

// Public repos (the default, and everything created so far): open to
// anyone, same as today. Private repos: a repo needs an explicit
// grant (any role, including "reader") for the signed-in Agent (web
// session) or the Agent resolved from a Basic Auth / bearer token
// (git CLI, API clients) -- one check, one principal, no "or any of
// my agents" indirection now that every Agent's standing is its own.
async function canReadRepo(request: Request, env: WebEnv, meta: Awaited<ReturnType<typeof readRepoMeta>>, roles: Awaited<ReturnType<typeof readRepoRoles>>): Promise<boolean> {
  if (meta?.policy.visibility !== "private") return true;
  const me = await resolveRequestAgent(request, env);
  const gitPrincipal = await resolveGitAuthPrincipal(request, env);
  const principals = [me?.id, gitPrincipal].filter((p): p is string => !!p);
  if (principals.length === 0) return false;
  return principals.some((p) => (roles?.grants ?? []).some((g) => g.principal === p));
}

// Push always requires real, resolved authentication -- never
// anonymous, even on a public repo (same as GitHub: public means
// publicly readable, not publicly writable). Gated at Maintainer or
// above, same bar as granting a changeset_review -- matching
// governance.md's own model (Contributor "needs a Maintainer's grant
// for each changeset"; a raw push bypasses that per-changeset review
// entirely, so it's deliberately held to the same authority that
// could grant the review anyway, not opened to every Contributor).
async function canPushRepo(request: Request, env: WebEnv, roles: Awaited<ReturnType<typeof readRepoRoles>>): Promise<boolean> {
  const principal = await resolveGitAuthPrincipal(request, env);
  if (!principal) return false;
  return repoAtLeast(repoRoleFor(roles, principal), "maintainer");
}

function needGitAuthResponse(): Response {
  return new Response("authentication required\n", { status: 401, headers: { "www-authenticate": 'Basic realm="zz"' } });
}

async function handleRepoPage(me: Agent | null, slug: string, request: Request, env: WebEnv, origin: string): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("no such repo", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.roles))) return new Response("no such repo", { status: 404 });
  const { repoRow, meta, roles } = ctx;

  using repo = await env.ARTIFACTS.get(repoRow.artifacts_name);
  const info = await repo.info();
  const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
  const tree: TreeEntry[] = head ? ((await repo.readTree(head.treeHash)) ?? []) : [];
  const readme = head ? await findReadme(repo, tree) : null;

  const fileListHtml = tree
    .map((e) => `<li>${e.type === "tree" ? "📁" : "📄"} ${esc(e.name)}${e.type !== "tree" ? ` <a href="${origin}/${esc(slug)}/blob/${esc(e.name)}">view/download</a>` : ""}</li>`)
    .join("");

  const rolesHtml = (roles?.grants ?? []).map((g) => `<span class="badge">${esc(g.principal)}: ${esc(g.role)}</span>`).join(" ");

  const lane = await getRootLane(env, repoRow.artifacts_name);
  const asksHtml = (lane?.history ?? [])
    .slice()
    .reverse()
    .map((e) => {
      if (e.type === "ASK") return `<li><b>ASK</b> (${esc(e.kind ?? "?")}) from ${esc(e.from ?? "?")} -- ${esc(JSON.stringify(e.payload ?? {}))} <span class="muted">${esc(e.at)}</span></li>`;
      if (e.type === "ANSWER") return `<li><b>ANSWER</b> ${esc(e.action ?? "?")} by ${esc(e.from ?? "?")} on ${esc(e.ask ?? "?")} <span class="muted">${esc(e.at)}</span></li>`;
      return `<li><b>INSIGHT</b> ${esc(JSON.stringify(e.payload ?? {}))} <span class="muted">${esc(e.at)}</span></li>`;
    })
    .join("");

  return layout(
    slug,
    me,
    `<p>${esc(meta?.description ?? repoRow.description ?? "")}</p>
     <p>${rolesHtml}</p>
     <p><a href="${origin}/${esc(slug)}/archive.zip">Download repo as .zip</a></p>
     <h2>Clone</h2>
     <pre>git clone ${esc(origin)}/${esc(slug)}</pre>
     <p class="muted">To push: issue yourself (or a managed agent) a token on <a href="/profile">your profile</a> (needs at least Maintainer on this repo). <code>zz repo clone ${esc(slug)}</code> handles this automatically if you're logged in via the CLI -- or use the token as the username when git prompts, password blank.</p>
     <h2>Files</h2>
     <ul>${fileListHtml || "<li class=\"muted\">Empty repo.</li>"}</ul>
     ${readme ? `<h2>README</h2><pre>${esc(readme)}</pre>` : ""}
     <h2>Asks (root Lane)</h2>
     <ul>${asksHtml || "<li class=\"muted\">No Asks posted yet.</li>"}</ul>`,
  );
}

async function handleBlob(slug: string, path: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("not found", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.roles))) return new Response("not found", { status: 404 });
  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  const info = await repo.info();
  const blob = await repo.readFile({ ref: info.defaultBranch, path });
  if (!blob) return new Response("not found", { status: 404 });
  return new Response(blob, { headers: { "content-type": blob.type || "application/octet-stream" } });
}

async function handleArchive(slug: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("not found", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.roles))) return new Response("not found", { status: 404 });
  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  const info = await repo.info();
  const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
  if (!head) return new Response("empty repo", { status: 404 });

  const files: Record<string, Uint8Array> = {};
  await walkTreeForZip(repo, head.treeHash, "", files);
  const zipped = zipSync(files);
  return new Response(zipped, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${ctx.repoRow.slug.replace("/", "-")}.zip"` } });
}

// --- Git smart-HTTP proxy, so the full range of git operations --
// clone, fetch, AND push -- work against `<origin>/<slug>` with no
// credential ever visible in a URL. See git-compatibility docs page
// for the full supported/unsupported surface.

type GitService = "git-upload-pack" | "git-receive-pack";

function stripHopByHopHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete("content-encoding");
  copy.delete("content-length");
  copy.delete("transfer-encoding");
  return copy;
}

async function checkGitServiceAccess(service: GitService, request: Request, env: WebEnv, ctx: { meta: Awaited<ReturnType<typeof readRepoMeta>>; roles: Awaited<ReturnType<typeof readRepoRoles>> }): Promise<"ok" | "need-auth" | "denied"> {
  if (service === "git-receive-pack") {
    if (await canPushRepo(request, env, ctx.roles)) return "ok";
    return request.headers.get("authorization") ? "denied" : "need-auth";
  }
  if (await canReadRepo(request, env, ctx.meta, ctx.roles)) return "ok";
  const isPrivate = ctx.meta?.policy.visibility === "private";
  return isPrivate && !request.headers.get("authorization") ? "need-auth" : "denied";
}

async function handleGitInfoRefs(slug: string, request: Request, env: WebEnv): Promise<Response> {
  const service = new URL(request.url).searchParams.get("service");
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return new Response("unsupported service", { status: 400 });
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("not found", { status: 404 });

  const access = await checkGitServiceAccess(service, request, env, ctx);
  if (access === "need-auth") return needGitAuthResponse();
  if (access === "denied") return new Response("not found", { status: 404 });

  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  const token = await repo.createToken(service === "git-receive-pack" ? "write" : "read", 120);
  const info = await repo.info();
  const tokenPlaintext = typeof token === "string" ? token : token.plaintext;
  const upstream = await fetch(`${info.remote}/info/refs?service=${service}`, {
    headers: { authorization: `Basic ${btoa(`x-token-auth:${tokenPlaintext}`)}` },
  });
  return new Response(upstream.body, { status: upstream.status, headers: stripHopByHopHeaders(upstream.headers) });
}

async function handleGitPack(service: GitService, slug: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("not found", { status: 404 });

  const access = await checkGitServiceAccess(service, request, env, ctx);
  if (access === "need-auth") return needGitAuthResponse();
  if (access === "denied") return new Response("not found", { status: 404 });

  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  const token = await repo.createToken(service === "git-receive-pack" ? "write" : "read", 120);
  const info = await repo.info();
  const tokenPlaintext = typeof token === "string" ? token : token.plaintext;
  const headers: Record<string, string> = {
    authorization: `Basic ${btoa(`x-token-auth:${tokenPlaintext}`)}`,
    "content-type": request.headers.get("content-type") ?? `application/x-${service}-request`,
  };
  const gitProtocol = request.headers.get("git-protocol");
  if (gitProtocol) headers["git-protocol"] = gitProtocol;
  const upstream = await fetch(`${info.remote}/${service}`, { method: "POST", headers, body: request.body });
  const response = new Response(upstream.body, { status: upstream.status, headers: stripHopByHopHeaders(upstream.headers) });

  if (service === "git-receive-pack" && upstream.ok) {
    await touchRepoUpdatedAt(env.DB, ctx.repoRow.id).catch(() => {});
  }
  return response;
}

// --- Dispatch ---

/** Returns null for any path this module doesn't own, so index.ts can fall through to its existing diagnostic routes. */
export async function handleWebRequest(request: Request, env: WebEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const origin = url.origin;

  if (path === "/login") return handleLogin(request);
  if (path === "/logout") return handleLogout(request, env);
  if (path === "/auth/start/cloudflare") return handleAuthStart("cloudflare", request, env);
  if (path === "/auth/start/google") return handleAuthStart("google", request, env);
  if (path === "/auth/callback/cloudflare") return handleAuthCallback("cloudflare", request, env);
  if (path === "/auth/callback/google") return handleAuthCallback("google", request, env);
  if (path === "/profile" && request.method === "GET") return handleProfile(request, env);
  if (path === "/profile/agents" && request.method === "POST") return handleCreateAgentForm(request, env);
  if (path === "/profile/rbac" && request.method === "POST") return handleRbacGrantForm(request, env);
  if (path === "/profile/ask" && request.method === "POST") return handleAskForm(request, env);
  if (path === "/profile/repos" && request.method === "POST") return handleCreateRepoForm(request, env);
  {
    const m = path.match(/^\/profile\/agents\/([^/]+)\/tokens$/);
    if (m && request.method === "POST") return handleMintTokenForm(m[1], request, env);
  }
  {
    const m = path.match(/^\/profile\/tokens\/([^/]+)\/revoke$/);
    if (m && request.method === "POST") return handleRevokeTokenForm(m[1], request, env);
  }
  if (path === "/explore") return handleExplore(request, env);

  // --- JSON API (CLI/agent parity with everything above) ---
  if (path === "/api/login/start" && request.method === "POST") return handleApiLoginStart(request, env);
  if (path === "/api/login/poll" && request.method === "GET") return handleApiLoginPoll(request, env);
  if (path === "/api/me" && request.method === "GET") return handleApiMe(request, env);
  if (path === "/api/agents" && request.method === "POST") return handleApiCreateAgent(request, env);
  if (path === "/api/agents" && request.method === "GET") return handleApiListAgents(request, env);
  if (path === "/api/repos" && request.method === "POST") return handleApiCreateRepo(request, env);
  if (path === "/api/repos" && request.method === "GET") return handleApiListRepos(request, env);
  {
    const m = path.match(/^\/api\/agents\/([^/]+)\/tokens$/);
    if (m && request.method === "POST") return handleApiMintToken(m[1], request, env);
  }
  {
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/roles$/);
    if (m && request.method === "POST") return handleApiRbacGrant(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/ask$/);
    if (m && request.method === "POST") return handleApiPostAsk(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/asks$/);
    if (m && request.method === "GET") return handleApiGetAsks(`${m[1]}/${m[2]}`, env);
  }
  {
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)$/);
    if (m && request.method === "GET") return handleApiGetRepo(`${m[1]}/${m[2]}`, env);
  }

  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/archive\.zip$/);
    if (m) return handleArchive(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) return handleBlob(`${m[1]}/${m[2]}`, m[3], request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/info\/refs$/);
    if (m) return handleGitInfoRefs(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/git-upload-pack$/);
    if (m) return handleGitPack("git-upload-pack", `${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/git-receive-pack$/);
    if (m) return handleGitPack("git-receive-pack", `${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)$/);
    if (m) {
      const me = await resolveRequestAgent(request, env);
      return handleRepoPage(me, `${m[1]}/${m[2]}`, request, env, origin);
    }
  }

  return null;
}

export { upsertRepo, type RepoRow, type Agent };
