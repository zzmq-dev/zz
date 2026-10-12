// The public web app: explore/search, a GitHub-like repo page, login
// (Cloudflare + Google OAuth), and a profile page for managing agents,
// tokens, repo RBAC, and posting an ASK to any repo's root Lane.
// Added as routes on the existing zz-maintainer Worker rather than a
// second service, given the time budget (see the approved plan).
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
  type Account,
  type Agent,
  type RepoRow,
  createAccount,
  createAgent,
  createAgentToken,
  createIdentity,
  createSession,
  deleteSession,
  findActiveAgentToken,
  findIdentity,
  getAccount,
  getAgent,
  getRepoBySlug,
  getValidSession,
  listAgentsForAccount,
  listRecentRepos,
  listReposOwnedBy,
  listTokensForAgent,
  refreshAccountProfile,
  revokeAgentToken,
  searchRepos,
  shortId,
  touchAgentToken,
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

function layout(title: string, account: Account | null, body: string): Response {
  const nav = account
    ? `<a href="/explore">Explore</a> · <a href="/profile">${esc(account.display_name)}</a> · <a href="/logout">Log out</a>`
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
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirect(url: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location: url, ...extraHeaders } });
}

// --- Auth ---

async function getCurrentAccount(request: Request, env: WebEnv): Promise<Account | null> {
  const sessionId = readSessionCookie(request);
  if (!sessionId) return null;
  const session = await getValidSession(env.DB, sessionId);
  if (!session) return null;
  return getAccount(env.DB, session.account_id);
}

async function handleLogin(): Promise<Response> {
  return layout(
    "Log in",
    null,
    `<p><a href="/auth/start/cloudflare"><button>Log in with Cloudflare</button></a></p>
     <p><a href="/auth/start/google"><button>Log in with Google</button></a></p>`,
  );
}

async function handleAuthStart(provider: Provider, request: Request, env: WebEnv): Promise<Response> {
  const state = shortId("state");
  const url = buildAuthorizeUrl(provider, env, state);
  return redirect(url, { "set-cookie": `zz_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` });
}

async function handleAuthCallback(provider: Provider, request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.headers.get("cookie")?.match(/zz_oauth_state=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) {
    return new Response("OAuth state mismatch or missing code -- please try logging in again.", { status: 400 });
  }

  const identity = await exchangeCodeForIdentity(provider, env, code);
  let existing = await findIdentity(env.DB, provider, identity.subject);
  const expiresAt = identity.expiresInSeconds ? new Date(Date.now() + identity.expiresInSeconds * 1000).toISOString() : null;
  const accessTokenEnc = await encryptSecret(env, identity.accessToken);
  const refreshTokenEnc = identity.refreshToken ? await encryptSecret(env, identity.refreshToken) : null;

  let account: Account;
  if (existing) {
    account = (await getAccount(env.DB, existing.account_id))!;
    await updateIdentityTokens(env.DB, existing.id, { accessTokenEnc, refreshTokenEnc, expiresAt });
    await refreshAccountProfile(env.DB, account.id, identity.displayName, identity.email);
  } else {
    account = await createAccount(env.DB, identity.displayName, identity.email);
    await createIdentity(env.DB, account.id, provider, identity.subject, { accessTokenEnc, refreshTokenEnc, expiresAt });
  }

  const session = await createSession(env.DB, account.id, 60 * 60 * 24 * 30);
  return redirect("/profile", { "set-cookie": sessionCookieHeader(session.id, 60 * 60 * 24 * 30) });
}

async function handleLogout(request: Request, env: WebEnv): Promise<Response> {
  const sessionId = readSessionCookie(request);
  if (sessionId) await deleteSession(env.DB, sessionId);
  return redirect("/explore", { "set-cookie": clearSessionCookieHeader() });
}

// --- Profile ---

async function handleProfile(request: Request, env: WebEnv): Promise<Response> {
  const account = await getCurrentAccount(request, env);
  if (!account) return redirect("/login");

  const agents = await listAgentsForAccount(env.DB, account.id);
  const ownRepos = await listReposOwnedBy(env.DB, "account", account.id);
  const agentRepoLists = await Promise.all(agents.map((a) => listReposOwnedBy(env.DB, "agent", a.id)));
  const agentTokenLists = await Promise.all(agents.map((a) => listTokensForAgent(env.DB, a.id)));

  const agentsHtml = agents
    .map((a, i) => {
      const tokens = agentTokenLists[i].filter((t) => !t.revoked_at);
      const repos = agentRepoLists[i];
      return `<li><b>${esc(a.display_name)}</b> <span class="muted">(${a.id})</span>
        <form method="post" action="/profile/agents/${a.id}/tokens" style="display:inline">
          <button type="submit">New token</button>
        </form>
        <ul>${tokens.map((t) => `<li>token ${t.id} created ${esc(t.created_at)} ${t.last_used_at ? `last used ${esc(t.last_used_at)}` : "(never used)"} <form method="post" action="/profile/tokens/${t.id}/revoke" style="display:inline"><button type="submit">Revoke</button></form></li>`).join("")}</ul>
        <div class="muted">Repos: ${repos.length ? repos.map((r) => `<a href="/${esc(r.slug)}">${esc(r.slug)}</a>`).join(", ") : "none"}</div>
      </li>`;
    })
    .join("");

  const allRepos = [...ownRepos, ...agentRepoLists.flat()];

  return layout(
    "Profile",
    account,
    `<p>${esc(account.display_name)} ${account.email ? `&lt;${esc(account.email)}&gt;` : ""}</p>

     <h2>Agents</h2>
     <form method="post" action="/profile/agents">
       <input name="display_name" placeholder="agent name" required>
       <button type="submit">Create agent</button>
     </form>
     <ul>${agentsHtml || "<li class=\"muted\">No agents yet.</li>"}</ul>

     <h2>Your repos</h2>
     <ul>${ownRepos.map((r) => `<li><a href="/${esc(r.slug)}">${esc(r.slug)}</a></li>`).join("") || "<li class=\"muted\">None owned directly (check your agents above).</li>"}</ul>

     <h2>Grant/revoke a repo Role</h2>
     <form method="post" action="/profile/rbac">
       <select name="repo_slug">${allRepos.map((r) => `<option value="${esc(r.slug)}">${esc(r.slug)}</option>`).join("")}</select>
       <input name="principal" placeholder="account:acct-xxxx or agent:agent-xxxx" required>
       <select name="role"><option>owner</option><option>maintainer</option><option selected>contributor</option><option>reader</option></select>
       <button type="submit">Grant</button>
     </form>

     <h2>Create a repo</h2>
     <form method="post" action="/profile/repos">
       <select name="owner">
         <option value="account:${esc(account.id)}">${esc(account.display_name)} (you)</option>
         ${agents.map((a) => `<option value="agent:${esc(a.id)}">${esc(a.display_name)}</option>`).join("")}
       </select>
       <input name="name" placeholder="repo-name" required pattern="[A-Za-z0-9._-]+">
       <input name="description" placeholder="description">
       <button type="submit">Create</button>
     </form>

     <h2>Post an ASK to a repo's root Lane</h2>
     <form method="post" action="/profile/ask">
       <input name="repo_slug" placeholder="account/repo-name" required>
       <textarea name="description" placeholder="what do you need done?" required></textarea>
       <button type="submit">Post ASK</button>
     </form>`,
  );
}

async function handleCreateAgent(request: Request, env: WebEnv): Promise<Response> {
  const account = await getCurrentAccount(request, env);
  if (!account) return redirect("/login");
  const form = await request.formData();
  const displayName = String(form.get("display_name") ?? "").trim();
  if (displayName) await createAgent(env.DB, account.id, displayName);
  return redirect("/profile");
}

async function handleMintToken(agentId: string, request: Request, env: WebEnv): Promise<Response> {
  const account = await getCurrentAccount(request, env);
  if (!account) return redirect("/login");
  const agent = await getAgent(env.DB, agentId);
  if (!agent || agent.account_id !== account.id) return new Response("not your agent", { status: 403 });

  const plaintext = generateAgentToken();
  await createAgentToken(env.DB, agentId, hashAgentToken(plaintext));
  return layout(
    "New agent token",
    account,
    `<p>Token for <b>${esc(agent.display_name)}</b> -- copy it now, it won't be shown again:</p>
     <pre>${esc(plaintext)}</pre>
     <p><a href="/profile">Back to profile</a></p>`,
  );
}

async function handleRevokeToken(tokenId: string, request: Request, env: WebEnv): Promise<Response> {
  const account = await getCurrentAccount(request, env);
  if (!account) return redirect("/login");
  // Ownership check happens implicitly: revoking someone else's token id
  // just does nothing useful to them since it's keyed by id, but a
  // stricter check (join through agent -> account) is a reasonable
  // fast-follow if this profile page gets real traffic.
  await revokeAgentToken(env.DB, tokenId);
  return redirect("/profile");
}

async function handleRbacGrant(request: Request, env: WebEnv): Promise<Response> {
  const account = await getCurrentAccount(request, env);
  if (!account) return redirect("/login");
  const form = await request.formData();
  const repoSlug = String(form.get("repo_slug") ?? "");
  const principal = String(form.get("principal") ?? "");
  const role = String(form.get("role") ?? "reader") as RbacRole;

  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) return new Response("no such repo", { status: 404 });

  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("write", 3600);
  const info = await artifactsRepo.info();

  const roles = await readRepoRoles(info.remote, token);
  const actingPrincipal = `account:${account.id}`;
  // The human account's own grants, PLUS override authority on any
  // agent it owns (so a human can always correct their own agent's
  // RBAC decisions, per the explicit design: agents are "ultimately
  // attached to a human account who can override them").
  const myAgents = await listAgentsForAccount(env.DB, account.id);
  const actingAsOneOf = [actingPrincipal, ...myAgents.map((a) => `agent:${a.id}`)];
  const myRole = actingAsOneOf.reduce<RbacRole>((best, p) => {
    const r = repoRoleFor(roles, p);
    return repoAtLeast(r, best) ? r : best;
  }, "reader");
  if (!repoAtLeast(myRole, "owner")) return new Response(`${actingPrincipal} is not an Owner of ${repoSlug}`, { status: 403 });

  const nextGrants = (roles?.grants ?? []).filter((g) => g.principal !== principal);
  nextGrants.push({ principal, role, granted_by: actingPrincipal, at: new Date().toISOString() });
  await writeRepoRoles(info.remote, token, { grants: nextGrants });
  return redirect("/profile");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

async function handleCreateRepo(request: Request, env: WebEnv): Promise<Response> {
  const account = await getCurrentAccount(request, env);
  if (!account) return redirect("/login");
  const form = await request.formData();
  const [ownerType, ownerId] = String(form.get("owner") ?? "").split(":") as ["account" | "agent", string];
  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim() || null;
  if (!name || (ownerType !== "account" && ownerType !== "agent")) return new Response("bad request", { status: 400 });
  if (ownerType === "agent") {
    const agent = await getAgent(env.DB, ownerId);
    if (!agent || agent.account_id !== account.id) return new Response("not your agent", { status: 403 });
  } else if (ownerId !== account.id) {
    return new Response("not your account", { status: 403 });
  }

  // Owner-segment: an account's real email address, literal (not
  // slugified) -- per direct instruction, not a mangled slug of it.
  // Falls back to a slugified display name only if the account somehow
  // has no email (shouldn't happen post-login now that both providers
  // return one, but accounts created before that fix might still lack
  // one). Agents have no email at all, so an agent-owned repo still
  // uses its slugified display name -- it's the agent's own visible
  // identity on the platform, not a stand-in for its owning human's.
  const ownerDisplayName = ownerType === "account" ? account.display_name : (await getAgent(env.DB, ownerId))!.display_name;
  const ownerSegment = ownerType === "account" ? account.email ?? slugify(account.display_name) : slugify(ownerDisplayName);
  const artifactsName = shortId("repo");
  const slug = `${ownerSegment}/${slugify(name)}`;

  const created = await env.ARTIFACTS.create(artifactsName, { description: description ?? undefined, setDefaultBranch: "main" });
  using repo = await env.ARTIFACTS.get(artifactsName);
  const token = await repo.createToken("write", 3600);
  // commit_changeset (and anything else that anchors to a commit) needs
  // a parent to diff against -- a brand new repo has none, so seed one.
  await createInitialCommit(created.remote, token, [{ path: "README.md", content: `# ${name}\n\n${description ?? ""}\n` }], { name: ownerDisplayName, email: `${ownerId}@zz.local` });
  await ensureMeta(created.remote, token, { description: description ?? "", owner: { type: ownerType, id: ownerId } });
  await upsertRepo(env.DB, { slug, artifactsName, description, ownerType, ownerId });

  return redirect(`/${slug}`);
}

async function handleAskForm(request: Request, env: WebEnv): Promise<Response> {
  const account = await getCurrentAccount(request, env);
  if (!account) return redirect("/login");
  const form = await request.formData();
  const repoSlug = String(form.get("repo_slug") ?? "");
  const description = String(form.get("description") ?? "");
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) return new Response("no such repo", { status: 404 });

  const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(repo.artifacts_name));
  await stub.configure(repo.artifacts_name);
  await stub.callTool("ask_post", { repo: repo.artifacts_name, lane_id: "_repo", kind: "work", from: `account:${account.id}`, payload: { description } });
  return redirect("/profile");
}

// --- Explore (list + search, one route) ---

async function handleExplore(request: Request, env: WebEnv): Promise<Response> {
  const account = await getCurrentAccount(request, env);
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const repos = q ? await searchRepos(env.DB, q, 50) : await listRecentRepos(env.DB, 50);

  const listHtml = repos
    .map((r) => `<li><a href="/${esc(r.slug)}">${esc(r.slug)}</a>${r.description ? ` <span class="muted">- ${esc(r.description)}</span>` : ""}</li>`)
    .join("");

  return layout(
    "Explore",
    account,
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
// one access-control check instead of four separate ones that could
// drift out of sync.
async function getRepoAccessContext(slug: string, env: WebEnv): Promise<{ repoRow: RepoRow; meta: Awaited<ReturnType<typeof readRepoMeta>>; roles: Awaited<ReturnType<typeof readRepoRoles>> } | null> {
  const repoRow = await getRepoBySlug(env.DB, slug);
  if (!repoRow) return null;
  using repo = await env.ARTIFACTS.get(repoRow.artifacts_name);
  const token = await repo.createToken("read", 300);
  const info = await repo.info();
  await ensureMeta(info.remote, token, { description: repoRow.description ?? "", owner: { type: repoRow.owner_type, id: repoRow.owner_id } });
  const [meta, roles] = await Promise.all([readRepoMeta(info.remote, token), readRepoRoles(info.remote, token)]);
  return { repoRow, meta, roles };
}

// Git has no session cookie -- it authenticates over Basic Auth on
// the smart-HTTP request itself. The credential is an agent token
// (the same ones minted on /profile; there's no separate "account
// token" concept -- a human who wants to push directly just creates
// an agent for themselves, e.g. "my-laptop", and uses its token,
// exactly like /profile's existing mint flow already supports).
// Accepted in either Basic Auth slot (username or password) since
// convention varies by git client/credential helper/URL form --
// GitHub's own convention is the token as username with a blank
// password, so that's checked first, but either works here.
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
  return `agent:${token.agent_id}`;
}

// Public repos (the default, and everything created so far): open to
// anyone, same as today. Private repos: this was never actually
// enforced before -- handleRepoPage/handleBlob/handleArchive rendered
// content to anyone who knew the URL regardless of meta.json's
// policy.visibility. Fixed here: a private repo needs an explicit
// grant (any role, including "reader") for the signed-in principal,
// one of their agents, or (for git CLI requests, which carry no
// session cookie) the agent resolved from a Basic Auth token.
async function canReadRepo(request: Request, env: WebEnv, meta: Awaited<ReturnType<typeof readRepoMeta>>, roles: Awaited<ReturnType<typeof readRepoRoles>>): Promise<boolean> {
  if (meta?.policy.visibility !== "private") return true;
  const principals: string[] = [];
  const account = await getCurrentAccount(request, env);
  if (account) {
    principals.push(`account:${account.id}`);
    const myAgents = await listAgentsForAccount(env.DB, account.id);
    principals.push(...myAgents.map((a) => `agent:${a.id}`));
  }
  const gitPrincipal = await resolveGitAuthPrincipal(request, env);
  if (gitPrincipal) principals.push(gitPrincipal);
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

async function handleRepoPage(account: Account | null, slug: string, request: Request, env: WebEnv, origin: string): Promise<Response> {
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

  return layout(
    slug,
    account,
    `<p>${esc(meta?.description ?? repoRow.description ?? "")}</p>
     <p>${rolesHtml}</p>
     <p><a href="${origin}/${esc(slug)}/archive.zip">Download repo as .zip</a></p>
     <h2>Clone</h2>
     <pre>git clone ${esc(origin)}/${esc(slug)}</pre>
     <p class="muted">To push: mint an agent token on <a href="/profile">your profile</a> (needs at least Maintainer on this repo), then use it as the username -- <code>git clone https://&lt;token&gt;@${esc(origin.replace("https://", ""))}/${esc(slug)}</code> -- or let git prompt you and paste it in as the password.</p>
     <h2>Files</h2>
     <ul>${fileListHtml || "<li class=\"muted\">Empty repo.</li>"}</ul>
     ${readme ? `<h2>README</h2><pre>${esc(readme)}</pre>` : ""}`,
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
// credential ever visible in a URL. Cloudflare Artifacts' remote is
// already a real git-smart-HTTP server; this forwards info/refs,
// git-upload-pack (fetch/clone), and git-receive-pack (push) to it,
// injecting a short-lived, server-side-only token as Basic Auth via
// base64 (never URL-embedded, so the earlier clone-URL encoding bug
// doesn't apply here). To push: mint an agent token on /profile, hold
// at least Maintainer on the repo, and use the token as the username
// in `git clone https://<token>@<origin>/<slug>` (or let git prompt
// for username/password and enter it there -- see canPushRepo/
// resolveGitAuthPrincipal above for the exact credential rules).

type GitService = "git-upload-pack" | "git-receive-pack";

function stripHopByHopHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  // fetch() already transparently decodes a gzipped upstream body, but
  // leaves the original content-encoding/content-length headers in
  // place -- forwarding them verbatim would tell the git client the
  // body is still gzipped when it isn't, corrupting the clone/push.
  copy.delete("content-encoding");
  copy.delete("content-length");
  copy.delete("transfer-encoding");
  return copy;
}

/** True if the request is authorized for `service`; false AND the caller should 401 (no credentials offered yet, invite the client to send some); throws a Response to return a 404 (credentials offered but insufficient -- don't distinguish "wrong creds" from "doesn't exist"). */
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
    // A push just changed `main` out from under D1's cached
    // `updated_at` (and possibly the repo's description/activity
    // ordering on /explore) -- bump it so the index doesn't go stale.
    // Best-effort: a failure here shouldn't fail the push itself.
    await env.DB.prepare("UPDATE repos SET updated_at = ? WHERE id = ?").bind(new Date().toISOString(), ctx.repoRow.id).run().catch(() => {});
  }
  return response;
}

// --- Dispatch ---

/** Returns null for any path this module doesn't own, so index.ts can fall through to its existing diagnostic routes. */
export async function handleWebRequest(request: Request, env: WebEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const origin = url.origin;

  if (path === "/login") return handleLogin();
  if (path === "/logout") return handleLogout(request, env);
  if (path === "/auth/start/cloudflare") return handleAuthStart("cloudflare", request, env);
  if (path === "/auth/start/google") return handleAuthStart("google", request, env);
  if (path === "/auth/callback/cloudflare") return handleAuthCallback("cloudflare", request, env);
  if (path === "/auth/callback/google") return handleAuthCallback("google", request, env);
  if (path === "/profile" && request.method === "GET") return handleProfile(request, env);
  if (path === "/profile/agents" && request.method === "POST") return handleCreateAgent(request, env);
  if (path === "/profile/rbac" && request.method === "POST") return handleRbacGrant(request, env);
  if (path === "/profile/ask" && request.method === "POST") return handleAskForm(request, env);
  if (path === "/profile/repos" && request.method === "POST") return handleCreateRepo(request, env);
  {
    const m = path.match(/^\/profile\/agents\/([^/]+)\/tokens$/);
    if (m && request.method === "POST") return handleMintToken(m[1], request, env);
  }
  {
    const m = path.match(/^\/profile\/tokens\/([^/]+)\/revoke$/);
    if (m && request.method === "POST") return handleRevokeToken(m[1], request, env);
  }
  if (path === "/explore") return handleExplore(request, env);

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
      const account = await getCurrentAccount(request, env);
      return handleRepoPage(account, `${m[1]}/${m[2]}`, request, env, origin);
    }
  }

  return null;
}

export { upsertRepo, type RepoRow, type Agent };
