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
  type LadderSearchHit,
  createAgent,
  createAgentIdentity,
  createAgentToken,
  createCliLoginSession,
  createSession,
  deleteRepoRow,
  deleteSession,
  findActiveAgentToken,
  findAgentIdentity,
  fulfillCliLoginSession,
  getAgent,
  getAgentByEmail,
  getAgentToken,
  getRepoBySlug,
  getValidSession,
  listAgentsCreatedBy,
  listRecentRepos,
  listReposOwnedBy,
  listRepoRolesForAgent,
  listTokensForAgent,
  pollAndConsumeCliLoginSession,
  refreshAgentProfile,
  revokeAgentToken,
  searchAgents,
  searchExplore,
  searchLadderIndex,
  searchRepos,
  shortId,
  syncRepoRoleCache,
  touchAgentToken,
  touchRepoUpdatedAt,
  updateIdentityTokens,
  updateRepoOwner,
  updateRepoVisibility,
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
import { ensureMeta, readRepoMeta, readRepoMetaAndRoles, readRepoRoles, repoAtLeast, repoRoleFor, writeRepoRoles, writeRepoMeta, type RbacRole } from "./repoMeta.js";
import { LICENSES, LICENSE_ORDER, type LicenseOption } from "./licenses.js";
import { isRef, type EmbeddedRung } from "../../engine/ladderNotes.js";
import { REPO_RUNG_PATH, type Rung } from "../../engine/ladder.js";
import { claimableAsks } from "../../engine/workqueue.js";
import type { AskEntry, HistoryEntry, Lane } from "../../engine/types.js";

export interface WebEnv extends OAuthEnv {
  ARTIFACTS: Artifacts;
  DB: D1Database;
  MAINTAINER_DO: DurableObjectNamespace<MaintainerDO>;
}

// --- HTML helpers ---

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** An Ask/Answer payload, pretty-printed instead of dumped as one unreadable JSON.stringify() line -- a scrollable box so a large field (e.g. a proposal's full file contents) doesn't blow out the rest of the page's layout. */
function jsonBlock(value: unknown): string {
  return `<pre class="json-blob">${esc(JSON.stringify(value ?? {}, null, 2))}</pre>`;
}

// A deliberately small markdown-to-HTML renderer for README display --
// not a CommonMark implementation, just headers/bold/italic/inline and
// fenced code/links/lists/paragraphs, which covers the overwhelming
// majority of real READMEs. Safe by construction rather than by
// sanitizing afterward: the source is HTML-escaped FIRST, so every
// regex below only ever adds tags around already-inert text -- a
// README containing a literal `<script>` can never produce one, since
// by the time any regex runs it's already the harmless text
// "&lt;script&gt;". Code block/inline-code contents are stashed before
// the other passes run so bold/italic/header markup never reaches
// inside them.
function renderMarkdown(src: string): string {
  let html = esc(src);

  const codeBlocks: string[] = [];
  html = html.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.push(`<pre><code>${code}</code></pre>`) - 1;
    return `\u0000CB${idx}\u0000`;
  });

  const inlineCode: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlineCode.push(`<code>${code}</code>`) - 1;
    return `\u0000IC${idx}\u0000`;
  });

  html = html
    .replace(/^###### (.*)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(?:^[-*] .*(?:\n|$))+/gm, (block) => `<ul>${block.trim().split("\n").map((l) => `<li>${l.replace(/^[-*] /, "")}</li>`).join("")}</ul>\n`);

  html = html
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/^<(h[1-6]|ul)/.test(trimmed) || /^\u0000CB\d+\u0000$/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  html = html.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => inlineCode[Number(i)]);
  html = html.replace(/\u0000CB(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)]);
  return html;
}

// A bold, dark design system -- a muted purple backdrop with a handful
// of saturated accents (pink/yellow/cyan/green/blue/red) reserved for
// things that are actually signal: an action button, a status badge,
// an id. Mirrors the TUI's own palette 1:1 (app/tui/theme.ts) so the
// web app and `zz top`/`zz work` read as the same product, not two
// unrelated tools glued together.
const WEB_CSS = `
:root{
  --bg:#1A0F2E; --panel:#241433; --surface:#2D1B4E; --border:#4A2F73; --muted:#B4A3D6; --fg:#F3EFFF;
  --pink:#FF2E92; --yellow:#E8FF3D; --cyan:#2EE6FF; --green:#4CFF6E; --blue:#5C8DFF; --red:#FF4466;
  --code-bg:#140B24;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--fg);line-height:1.6}
a{color:var(--cyan);text-decoration:none} a:hover{text-decoration:underline;color:var(--pink)}
header.topbar{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--border);padding:.75rem 1.5rem;display:flex;align-items:center;justify-content:space-between;z-index:10}
.brand{font-weight:800;font-size:1.3rem;letter-spacing:-.02em;color:var(--pink)}
.brand span{color:var(--muted);font-weight:400}
nav.links a{margin-left:1.25rem;color:var(--muted);font-size:.92rem}
nav.links a:hover{color:var(--pink)}
main{max-width:980px;margin:0 auto;padding:2rem 1.5rem 4rem}
h1{font-size:1.5rem;margin:0 0 1.25rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.25rem 1.4rem;margin-bottom:1.25rem}
.card h2{margin:0 0 .6rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.stack>*+*{margin-top:.75rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.badge{display:inline-flex;align-items:center;padding:.15rem .6rem;border-radius:999px;font-size:.78rem;font-weight:600;border:1px solid;white-space:nowrap}
.badge-pink{color:var(--pink);background:rgba(255,46,146,.12);border-color:rgba(255,46,146,.4)}
.badge-yellow{color:var(--yellow);background:rgba(232,255,61,.1);border-color:rgba(232,255,61,.35)}
.badge-cyan{color:var(--cyan);background:rgba(46,230,255,.1);border-color:rgba(46,230,255,.35)}
.badge-green{color:var(--green);background:rgba(76,255,110,.1);border-color:rgba(76,255,110,.35)}
.badge-blue{color:var(--blue);background:rgba(92,141,255,.1);border-color:rgba(92,141,255,.35)}
.badge-red{color:var(--red);background:rgba(255,68,102,.1);border-color:rgba(255,68,102,.35)}
.badge-muted{color:var(--muted);background:rgba(180,163,214,.08);border-color:var(--border)}
.mono{font-family:var(--mono);background:var(--code-bg);color:var(--cyan);padding:.1rem .4rem;border-radius:5px;font-size:.88em}
pre{font-family:var(--mono);background:var(--code-bg);color:var(--fg);padding:.9rem 1rem;border-radius:8px;overflow-x:auto;border:1px solid var(--border)}
table{border-collapse:collapse;width:100%;font-size:.92rem}
td,th{padding:.5rem .4rem;border-bottom:1px solid var(--border);text-align:left}
th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:.75rem;letter-spacing:.05em}
ul.list{list-style:none;padding:0;margin:0}
ul.list>li{padding:.65rem 0;border-bottom:1px solid var(--border)}
ul.list>li:last-child{border-bottom:none}
.repo-item{display:flex;flex-direction:column;gap:.15rem}
.repo-item .name{font-family:var(--mono);color:var(--pink);font-weight:600}
.repo-item .desc{color:var(--muted);font-size:.9rem}
input,select,textarea{font-family:var(--sans);font-size:.95rem;padding:.55rem .7rem;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--fg)}
input::placeholder,textarea::placeholder{color:var(--muted)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--pink);box-shadow:0 0 0 2px rgba(255,46,146,.25)}
textarea{width:100%;min-height:4.5rem;resize:vertical;display:block}
button{font-family:var(--sans);font-size:.92rem;font-weight:700;padding:.55rem 1.1rem;border-radius:8px;border:1px solid var(--pink);background:var(--pink);color:#1A0F2E;cursor:pointer}
button:hover{background:#ff58a8}
button.secondary{background:transparent;color:var(--fg);border-color:var(--border)}
button.secondary:hover{border-color:var(--muted);background:rgba(180,163,214,.08)}
button.danger{background:transparent;color:var(--red);border-color:var(--red)}
button.danger:hover{background:rgba(255,68,102,.1)}
form{margin:0}
form.inline{display:inline}
.field-row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.field-row>input,.field-row>select{flex:1;min-width:10rem}
.muted{color:var(--muted);font-size:.9rem}
.hint{color:var(--muted);font-size:.88rem;margin:0 0 1rem}
.empty{color:var(--muted);font-style:italic;padding:.5rem 0}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem}
.card-head h2{margin:0}
.icon-btn{width:1.8rem;height:1.8rem;padding:0;border-radius:999px;font-size:1.1rem;line-height:1;display:inline-flex;align-items:center;justify-content:center}
dialog.modal{border:none;border-radius:12px;padding:0;background:var(--surface);color:var(--fg);border:1px solid var(--border);max-width:460px;width:92vw}
dialog.modal::backdrop{background:rgba(10,6,20,.65)}
dialog.modal .modal-body{padding:1.25rem 1.4rem}
dialog.modal h3{margin:0 0 1rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
dialog.modal .modal-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.1rem}
.ac-wrap{position:relative}
.ac-list{position:absolute;top:100%;left:0;right:0;background:var(--panel);border:1px solid var(--border);border-radius:8px;margin-top:.25rem;max-height:220px;overflow-y:auto;z-index:30}
.ac-item{padding:.5rem .7rem;cursor:pointer;font-size:.88rem}
.ac-item:hover,.ac-item.active{background:var(--surface)}
.tab-bar{display:flex;gap:.25rem;border-bottom:1px solid var(--border);margin-bottom:1rem;flex-wrap:wrap}
.tab-btn{background:none;border:none;color:var(--muted);font-weight:600;padding:.5rem .9rem;border-bottom:2px solid transparent;border-radius:0;cursor:pointer}
.tab-btn.active{color:var(--pink);border-bottom-color:var(--pink)}
.tab-btn:hover{color:var(--fg);background:none}
select.role-select{appearance:none;-webkit-appearance:none;background:transparent;border:1px solid var(--border);color:var(--fg);padding:.2rem .5rem;border-radius:6px;font-size:.85rem}
select.role-select:disabled{opacity:1;color:var(--fg);border-color:transparent;background:rgba(180,163,214,.08)}
.split{display:flex;justify-content:space-between;gap:1.5rem;flex-wrap:wrap}
.split>div{flex:1 1 16rem;min-width:0}
.align-right{text-align:right}
.align-right pre{text-align:left}
.danger-zone{border-color:rgba(255,68,102,.4)}
h1 .badge{margin-left:.7rem;vertical-align:middle;font-size:.6em}
.clone-row{display:flex;gap:.5rem;align-items:stretch}
.clone-row pre{flex:1;min-width:0;margin:0}
.log-feed{font-family:var(--mono);font-size:.85rem;line-height:1.8}
.log-line{white-space:nowrap;overflow-x:auto}
.log-line .t-ask{color:var(--yellow);font-weight:600}
.log-line .t-answer{color:var(--green);font-weight:600}
.log-line .t-insight{color:var(--cyan);font-weight:600}
.md h1,.md h2,.md h3{margin:1rem 0 .5rem}
.md h1:first-child,.md h2:first-child,.md h3:first-child{margin-top:0}
.md p{margin:.6rem 0}
.md ul{margin:.4rem 0;padding-left:1.4rem}
.md a{color:var(--cyan)}
.md pre{margin:.6rem 0}
.md code{font-family:var(--mono);background:var(--code-bg);padding:.1rem .35rem;border-radius:4px;font-size:.88em}
.md pre code{background:none;padding:0}
.blob-header{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;padding:.75rem 1rem;background:var(--panel);border:1px solid var(--border);border-radius:8px 8px 0 0;margin-bottom:0}
.blob-header a{color:var(--cyan)}
.download-btn{margin-left:auto;font-size:.85rem;font-weight:700;padding:.35rem .8rem;border-radius:8px;border:1px solid var(--pink);background:var(--pink);color:#1A0F2E !important}
.download-btn:hover{background:#ff58a8;text-decoration:none}
.blob-body{border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;overflow:hidden}
.blob-body pre{margin:0;border:none;border-radius:0}
.commit-nav{display:flex;justify-content:space-between;gap:1rem;margin-top:1rem}
.json-blob{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;margin:0;max-height:260px;overflow:auto;font-family:var(--mono);font-size:.82rem;white-space:pre}
`;

function card(heading: string, innerHtml: string, opts: { addModal?: string; extraClass?: string } = {}): string {
  const addBtn = opts.addModal ? `<button type="button" class="icon-btn" onclick="document.getElementById('${opts.addModal}').showModal()" aria-label="Add" title="Add">+</button>` : "";
  return `<section class="card${opts.extraClass ? ` ${opts.extraClass}` : ""}"><div class="card-head"><h2>${esc(heading)}</h2>${addBtn}</div>${innerHtml}</section>`;
}

const ROLE_BADGE_VARIANT: Record<string, string> = { owner: "pink", maintainer: "blue", contributor: "green", reader: "muted" };
const LANE_STATUS_BADGE_VARIANT: Record<string, string> = { proposed: "yellow", open: "yellow", claimed: "blue", active: "cyan", merged: "green", closed: "muted", vetoed: "red", stopped: "red" };
function roleBadge(role: string): string {
  return `<span class="badge badge-${ROLE_BADGE_VARIANT[role] ?? "muted"}">${esc(role)}</span>`;
}

/** A text input that autocompletes against /api/agents/search as you type -- used anywhere a form asks for a principal (grant-role, add-token, transfer-ownership). Fills in the agent's `username` (the one identifier there is) once a suggestion is clicked; typing one directly and not picking a suggestion still works, same as before. */
function agentAutocompleteField(name: string, placeholder: string, idSuffix: string): string {
  const boxId = `ac-box-${idSuffix}`;
  return `<div class="ac-wrap">
    <input name="${name}" placeholder="${esc(placeholder)}" required autocomplete="off" data-autocomplete="${boxId}" data-ac-url="/api/agents/search">
    <div id="${boxId}" class="ac-list" hidden></div>
  </div>`;
}

// Generic, reused across every page: `data-tabs` containers get click-
// to-switch tab panels, `data-autocomplete` inputs get a debounced
// agent search dropdown. No framework -- every page here is server-
// rendered and form-POST-driven already, so this stays a handful of
// plain DOM calls rather than a client-side rendering layer.
const WEB_JS = `
function zzInitTabs(container) {
  var btns = container.querySelectorAll('.tab-btn');
  btns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      btns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      container.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = true; });
      document.getElementById(btn.dataset.target).hidden = false;
    });
  });
}
document.querySelectorAll('[data-tabs]').forEach(zzInitTabs);

function zzAutocomplete(inputEl, listEl, url) {
  var t;
  inputEl.addEventListener('input', function () {
    clearTimeout(t);
    var q = inputEl.value.trim();
    if (!q) { listEl.hidden = true; listEl.innerHTML = ''; return; }
    t = setTimeout(function () {
      fetch(url + '?q=' + encodeURIComponent(q)).then(function (r) { return r.ok ? r.json() : { agents: [] }; }).then(function (data) {
        listEl.innerHTML = '';
        (data.agents || []).forEach(function (a) {
          var item = document.createElement('div');
          item.className = 'ac-item';
          item.textContent = a.username;
          item.onclick = function () { inputEl.value = a.username; listEl.hidden = true; };
          listEl.appendChild(item);
        });
        listEl.hidden = (data.agents || []).length === 0;
      });
    }, 200);
  });
  inputEl.addEventListener('blur', function () { setTimeout(function () { listEl.hidden = true; }, 150); });
}
document.querySelectorAll('[data-autocomplete]').forEach(function (el) {
  zzAutocomplete(el, document.getElementById(el.dataset.autocomplete), el.dataset.acUrl);
});

function zzExploreSearch(inputEl, listEl) {
  var t;
  function addItem(variant, label, href) {
    var item = document.createElement('div');
    item.className = 'ac-item';
    var badge = document.createElement('span');
    badge.className = 'badge badge-' + variant;
    badge.style.marginRight = '.5rem';
    badge.textContent = variant === 'pink' ? 'repo' : variant === 'cyan' ? 'user' : 'ladder';
    item.appendChild(badge);
    item.appendChild(document.createTextNode(label));
    item.onclick = function () { window.location.href = href; };
    listEl.appendChild(item);
  }
  inputEl.addEventListener('input', function () {
    clearTimeout(t);
    var q = inputEl.value.trim();
    if (!q) { listEl.hidden = true; listEl.innerHTML = ''; return; }
    t = setTimeout(function () {
      fetch('/api/explore/search?q=' + encodeURIComponent(q)).then(function (r) { return r.ok ? r.json() : { repos: [], agents: [], ladderHits: [] }; }).then(function (data) {
        listEl.innerHTML = '';
        (data.repos || []).forEach(function (r) { addItem('pink', r.slug, '/' + r.slug); });
        (data.agents || []).forEach(function (a) { addItem('cyan', a.username, '/' + a.username); });
        (data.ladderHits || []).forEach(function (h) { addItem('yellow', h.repo_slug + ': ' + h.summary.slice(0, 60), '/' + h.repo_slug + '/blob/' + h.path); });
        listEl.hidden = (data.repos || []).length === 0 && (data.agents || []).length === 0 && (data.ladderHits || []).length === 0;
      });
    }, 200);
  });
  inputEl.addEventListener('blur', function () { setTimeout(function () { listEl.hidden = true; }, 150); });
}
document.querySelectorAll('[data-explore-search]').forEach(function (el) {
  zzExploreSearch(el, document.getElementById(el.dataset.exploreSearch));
});

document.querySelectorAll('[data-copy]').forEach(function (btn) {
  var original = btn.textContent;
  btn.addEventListener('click', function () {
    navigator.clipboard.writeText(btn.dataset.copy).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = original; }, 1200);
    });
  });
});
`;

function layout(title: string, agent: Agent | null, body: string, opts: { cookies?: string[]; titleHtml?: string } = {}): Response {
  // Same items, same order, as the docs site's own nav (site/themes/zz-docs/fragments/header.html) --
  // Explore/Work/Docs/Source always present, then whatever's auth-dependent.
  const navHead = `<a href="/explore">Explore</a><a href="/work">Work</a><a href="/docs/">Docs</a><a href="https://github.com/zzmq-dev/zz">Source</a>`;
  const nav = agent ? `${navHead}<a href="/${esc(agent.username)}">${esc(agent.username)}</a><a href="/logout">Log out</a>` : `${navHead}<a href="/login">Log in</a>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - zz</title>
<style>${WEB_CSS}</style></head><body>
<header class="topbar"><a href="/" class="brand">zz<span>_</span></a><nav class="links">${nav}</nav></header>
<main>
<h1>${esc(title)}${opts.titleHtml ?? ""}</h1>
${body}
</main>
<script>${WEB_JS}</script>
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
    if (session) return getAgent(env.DB, session.agent_username);
  }
  const bearer = readBearerToken(request);
  if (bearer) {
    const token = await findActiveAgentToken(env.DB, hashAgentToken(bearer));
    if (token) {
      await touchAgentToken(env.DB, token.id);
      return getAgent(env.DB, token.agent_username);
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
    `${cliNonce ? '<p class="hint">Logging in for the zz CLI -- this browser tab can be closed once it redirects back.</p>' : ""}
     <div class="card stack">
       <a href="/auth/start/cloudflare${qs}"><button style="width:100%">Log in with Cloudflare</button></a>
       <a href="/auth/start/google${qs}"><button class="secondary" style="width:100%">Log in with Google</button></a>
     </div>`,
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
    agent = (await getAgent(env.DB, existing.agent_username))!;
    await updateIdentityTokens(env.DB, existing.id, { accessTokenEnc, refreshTokenEnc, expiresAt });
    await refreshAgentProfile(env.DB, agent.username, identity.displayName, identity.email);
  } else {
    // A second OAuth provider with the SAME verified email links to
    // the agent that already owns that email instead of minting a
    // disconnected duplicate -- confirmed live as a real bug: logging
    // in with Google, then later with Cloudflare, produced two
    // separate Agents sharing no history (different provider_subject,
    // so findAgentIdentity above correctly found nothing -- the gap
    // was never checking for an existing Agent by email before
    // falling through to createAgent).
    const byEmail = identity.email ? await getAgentByEmail(env.DB, identity.email) : null;
    if (byEmail) {
      agent = byEmail;
      await refreshAgentProfile(env.DB, agent.username, identity.displayName, identity.email);
    } else {
      agent = await createAgent(env.DB, identity.displayName, identity.email, null);
    }
    await createAgentIdentity(env.DB, agent.username, provider, identity.subject, { accessTokenEnc, refreshTokenEnc, expiresAt });
  }

  const session = await createSession(env.DB, agent.username, 60 * 60 * 24 * 30);

  // CLI bridge: a `zz login` browser tab carries a nonce through as a
  // cookie; fulfill it with a fresh bearer token so the waiting CLI
  // process can pick it up on its next poll. The web session above is
  // independent -- this tab also ends up logged in normally if left open.
  if (cliNonce) {
    const plaintext = generateAgentToken();
    await createAgentToken(env.DB, agent.username, hashAgentToken(plaintext));
    const fulfilled = await fulfillCliLoginSession(env.DB, cliNonce, agent.username, plaintext);
    if (fulfilled) {
      return layout(
        "Logged in",
        agent,
        `<div class="card"><p>Logged in as <b class="mono">${esc(agent.username)}</b>. You can close this tab and return to your terminal.</p></div>`,
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
  const existingTokens = (await listTokensForAgent(env.DB, agent.username)).filter((t) => !t.revoked_at);
  if (existingTokens.length === 0) {
    const plaintext = generateAgentToken();
    await createAgentToken(env.DB, agent.username, hashAgentToken(plaintext));
    return layout(
      "Welcome",
      agent,
      `<div class="card stack">
         <p>Logged in as <b class="mono">${esc(agent.username)}</b>. Here's a token for <code>git push</code>, the CLI, or any script acting as you -- copy it now, it won't be shown again:</p>
         <div class="clone-row"><pre>${esc(plaintext)}</pre><button class="secondary icon-btn" data-copy="${esc(plaintext)}" title="Copy">⧉</button></div>
         <p><a href="/${esc(agent.username)}">Continue to your profile &rarr;</a></p>
       </div>`,
      { cookies: [sessionCookieHeader(session.id, 60 * 60 * 24 * 30)] },
    );
  }

  return redirect(`/${agent.username}`, { cookies: [sessionCookieHeader(session.id, 60 * 60 * 24 * 30)] });
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
  const agent = await getAgent(env.DB, result.agentUsername);
  return json({ status: "ready", token: result.token, agent: { username: agent?.username ?? result.agentUsername } });
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
  const agent = await createAgent(env.DB, displayName.trim(), null, creator.username);
  const token = generateAgentToken();
  await createAgentToken(env.DB, agent.username, hashAgentToken(token));
  return { agent, token };
}

/** Minting a token for an agent is allowed for the agent itself (re-authenticating with an existing token/session) or whoever created it -- a practical bootstrap allowance (a brand-new agent has no credential yet, so someone has to issue its first one), not a general override. */
async function requireTokenMintAuthority(env: WebEnv, actor: Agent, targetUsername: string): Promise<Agent> {
  const target = await getAgent(env.DB, targetUsername);
  if (!target) throw new ApiError(404, "no such agent");
  if (target.username !== actor.username && target.created_by !== actor.username) throw new ApiError(403, "you can only mint tokens for yourself or an agent you created");
  return target;
}

async function doMintToken(env: WebEnv, actor: Agent, targetUsername: string): Promise<{ agent: Agent; token: string }> {
  const target = await requireTokenMintAuthority(env, actor, targetUsername);
  const plaintext = generateAgentToken();
  await createAgentToken(env.DB, target.username, hashAgentToken(plaintext));
  return { agent: target, token: plaintext };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/** The repo URL's owner segment, and the segment at /<username> for this Agent's own profile page. Frozen at creation (accountsDb.ts's createAgent) rather than recomputed live from display_name -- see migration 0003's header for why that matters. */
function ownerUrlSegment(agent: Agent): string {
  return agent.username;
}

// A new repo's Ladder is bootstrapped mechanically, never via an LLM
// call -- repo creation has to stay fast and free, and "fold in a
// summary" (the one case ladder_write_rung's own CUMULATIVE_SUMMARY_KINDS
// handling calls a model) only triggers when a rung ALREADY has a
// summary to fold against, which a brand-new repo never does. These
// mechanical summaries match exactly what agent/tools.ts's own
// mechanicalFileChangeRung already falls back to for large commits
// ("added."), not a new convention.
function buildInitialLadderRungs(opts: { description: string | null; ownerName: string; sha: string; readmeFirstLine: string; license: LicenseOption | null }): Rung[] {
  const at = new Date().toISOString();
  const source = (title: string) => [{ kind: "commit" as const, ref: opts.sha, title, author: opts.ownerName, at }];

  const readmeRung: Rung = { path: "README.md", kind: "file", summary: opts.readmeFirstLine || "Project README.", sources: source("Initial commit"), children: [] };
  const licenseRung: Rung | null = opts.license ? { path: "LICENSE", kind: "file", summary: `${opts.license.name} license.`, sources: source("Initial commit"), children: [] } : null;

  const changesetRung: Rung = {
    // Full sha, not truncated -- the established convention
    // (agent/tools.ts's VALID_RUNG_EXAMPLE, cli/commands/work.ts's own
    // comment), and load-bearing for the Cloudflare backend
    // specifically: readAnchor derives the anchor sha directly from
    // this path for "changesets/" paths (see its own comment), so a
    // truncated sha would make this rung permanently unreadable.
    path: `changesets/${opts.sha}`,
    kind: "changeset",
    summary: `Initial commit: added README.md${opts.license ? ", LICENSE" : ""}.`,
    sources: source("Initial commit"),
    children: [
      { path: "README.md", kind: "filechange", summary: "added.", sources: source("Initial commit"), children: [] },
      ...(opts.license ? [{ path: "LICENSE", kind: "filechange" as const, summary: "added.", sources: source("Initial commit"), children: [] }] : []),
    ],
  };

  const repoRung: Rung = {
    path: REPO_RUNG_PATH,
    kind: "repo",
    summary: `${(opts.description?.trim() || "No description").replace(/\.$/, "")}. Contains README.md${opts.license ? ` and a ${opts.license.name} LICENSE` : ""}.`,
    sources: source("Initial commit"),
    children: [],
  };

  return [repoRung, readmeRung, ...(licenseRung ? [licenseRung] : []), changesetRung];
}

async function doCreateRepo(env: WebEnv, owner: Agent, name: string, description: string | null, licenseKey: string | null): Promise<RepoRow> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ApiError(400, "repo name must match [A-Za-z0-9._-]+");
  const artifactsName = shortId("repo");
  const slug = `${ownerUrlSegment(owner)}/${slugify(name)}`;
  const license = licenseKey ? LICENSES[licenseKey] : null;

  const created = await env.ARTIFACTS.create(artifactsName, { description: description ?? undefined, setDefaultBranch: "main" });
  using repo = await env.ARTIFACTS.get(artifactsName);
  const token = await repo.createToken("write", 3600);
  // commit_changeset (and anything else that anchors to a commit) needs
  // a parent to diff against -- a brand new repo has none, so seed one.
  const readmeContent = `# ${name}\n\n${description ?? ""}\n`;
  const files = [{ path: "README.md", content: readmeContent }];
  if (license) files.push({ path: "LICENSE", content: license.text(owner.display_name, new Date().getFullYear()) });
  const sha = await createInitialCommit(created.remote, token, files, { name: owner.display_name, email: owner.email ?? `${owner.username}@zz.local` });
  await ensureMeta(created.remote, token, { description: description ?? "", owner: owner.username });
  const row = await upsertRepo(env.DB, { slug, artifactsName, description, ownerUsername: owner.username });
  await syncRepoRoleCache(env.DB, row.slug, [{ principal: owner.username, role: "owner", granted_by: "system", at: row.created_at }]);

  const readmeFirstLine = (readmeContent.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
  const rungs = buildInitialLadderRungs({ description, ownerName: owner.display_name, sha, readmeFirstLine, license });
  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  await stub.callTool("ladder_write_rung", { repo: artifactsName, rung: rungs });

  return row;
}

// Stopwords stripped so the character budget buys meaningful words, not
// filler -- "add the sum function" and "add sum function" should slugify
// to the same thing.
const TASK_SLUG_STOPWORDS = new Set(["a", "an", "the", "to", "for", "and", "or", "of", "in", "on", "with", "is", "are", "this", "that"]);
const TASK_SLUG_MAX_CHARS = 40;
const SHARD_SLUG_MAX_CHARS = 100;

/** Turns a task's free-text description into a short, meaningful bracket segment ("add the sum function" -> "add-sum-function"). Not a blind character truncation: stopwords are dropped first so the ~40-char budget is spent on words that actually distinguish the task, and whole words are kept (never cut mid-word). */
function slugifyTask(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w && !TASK_SLUG_STOPWORDS.has(w));
  const kept: string[] = [];
  let len = 0;
  for (const w of words) {
    const next = len + (kept.length > 0 ? 1 : 0) + w.length;
    if (next > TASK_SLUG_MAX_CHARS) break;
    kept.push(w);
    len = next;
  }
  return kept.join("-") || "task";
}

/** A short, stable stand-in for a slug segment that's too long to keep verbatim -- deterministic (same input always collapses the same way) so re-deriving a shard's slug twice still agrees. */
function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 8);
}

/** Computes a shard's slug from its parent's, appending `[taskSlug]` to the parent's repo-name segment and re-prefixing with the acting agent's own username -- the bracket-array-accessor convention the user chose for agent identities, extended to task decomposition. Recursive by construction: `parentSlug` may itself already be a shard's slug (it already carries its own bracket chain), so sharding a shard needs no special-casing here. If the result would exceed the overall length budget, the parent's chain prefix collapses into a short deterministic hash first, rather than growing the segment itself shorter (see slugifyTask's own comment for why). */
function shardSlug(parentSlug: string, actorUsername: string, taskSlug: string): string {
  const slashIdx = parentSlug.indexOf("/");
  const parentName = slashIdx === -1 ? parentSlug : parentSlug.slice(slashIdx + 1);
  let name = `${parentName}[${taskSlug}]`;
  if (actorUsername.length + 1 + name.length > SHARD_SLUG_MAX_CHARS) {
    name = `${shortHash(parentName)}[${taskSlug}]`;
  }
  return `${actorUsername}/${name}`;
}

/** Create-or-reuse a task shard: a real forked repo (ArtifactsRepo.fork, full default-branch history) scoped to one task, owned by the acting agent. `parentSlug` is whatever repo the task's own Lane currently lives in -- the true origin on a first-level shard, or an existing shard's slug when a sub-agent is being delegated a piece of an already-sharded task, which is what makes this recursive without extra code (see the user's "foo[task-a][task-b]" naming request). Idempotent: the slug is fully deterministic from (actorUsername, parentSlug, taskText), so a repeated call for the same task reuses the same shard rather than creating a new one each time. */
async function ensureShard(env: WebEnv, parentSlug: string, actor: Agent, taskText: string): Promise<RepoRow> {
  const parentRow = await getRepoBySlug(env.DB, parentSlug);
  if (!parentRow) throw new ApiError(404, `no such repo "${parentSlug}"`);

  const taskSlug = slugifyTask(taskText);
  let slug = shardSlug(parentSlug, actor.username, taskSlug);

  const existing = await getRepoBySlug(env.DB, slug);
  if (existing) {
    if (existing.shard_of_slug === parentSlug) return existing;
    // Same (actor, parent, taskSlug) collided with an unrelated repo --
    // the numeric-suffix convention already used elsewhere in this
    // account's own repo list (e.g. "khkjhkh"/"khkjhkh2").
    let n = 2;
    while (await getRepoBySlug(env.DB, `${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }

  const artifactsName = shortId("shard");
  using parentRepo = await env.ARTIFACTS.get(parentRow.artifacts_name);
  const created = await parentRepo.fork(artifactsName, { description: `${taskText} -- shard of ${parentSlug}` });
  using shardRepo = await env.ARTIFACTS.get(artifactsName);
  const token = await shardRepo.createToken("write", 3600);

  // Unconditional writes, not ensureMeta's "only if missing" check --
  // confirmed live that ArtifactsRepo.fork carries the zz-meta branch
  // over from the parent regardless of defaultBranchOnly, so
  // ensureMeta's existing-content check would see the PARENT's
  // meta.json/roles.json (wrong owner/description/no shard_of) and
  // silently no-op, leaving them stale. A freshly created shard always
  // needs its own values written, never inherited ones.
  const now = new Date().toISOString();
  await writeRepoMeta(created.remote, token, {
    description: taskText,
    policy: { require_changeset_review: false, visibility: "public" },
    owner: actor.username,
    shard_of: parentSlug,
    created_at: now,
  });
  await writeRepoRoles(created.remote, token, { grants: [{ principal: actor.username, role: "owner", granted_by: "system", at: now }] });

  const row = await upsertRepo(env.DB, { slug, artifactsName, description: taskText, ownerUsername: actor.username, shardOfSlug: parentSlug });
  await syncRepoRoleCache(env.DB, row.slug, [{ principal: actor.username, role: "owner", granted_by: "system", at: row.created_at }]);
  return row;
}

async function doRbacGrant(env: WebEnv, actor: Agent, repoSlug: string, principal: string, role: RbacRole): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such repo");
  if (!(await getAgent(env.DB, principal))) throw new ApiError(404, `no such agent "${principal}"`);

  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("write", 3600);
  const info = await artifactsRepo.info();

  const roles = await readRepoRoles(info.remote, token);
  // No more "or any agent I created" indirection -- peers means the
  // ACTOR's own standing is what's checked, full stop, same as every
  // other RBAC check in this codebase (canReadRepo/canPushRepo).
  if (!repoAtLeast(repoRoleFor(roles, actor.username), "owner")) throw new ApiError(403, `${actor.username} is not an Owner of ${repoSlug}`);

  const nextGrants = (roles?.grants ?? []).filter((g) => g.principal !== principal);
  nextGrants.push({ principal, role, granted_by: actor.username, at: new Date().toISOString() });
  await writeRepoRoles(info.remote, token, { grants: nextGrants });
  await syncRepoRoleCache(env.DB, repo.slug, nextGrants);
}

/** Removes one grant by its exact stored `principal` value -- doesn't require it to resolve to a current agent, so a stale/orphaned grant can still be cleaned up. */
async function doRevokeGrant(env: WebEnv, actor: Agent, repoSlug: string, principal: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such repo");
  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("write", 3600);
  const info = await artifactsRepo.info();
  const roles = await readRepoRoles(info.remote, token);
  if (!repoAtLeast(repoRoleFor(roles, actor.username), "owner")) throw new ApiError(403, `${actor.username} is not an Owner of ${repoSlug}`);
  const nextGrants = (roles?.grants ?? []).filter((g) => g.principal !== principal);
  await writeRepoRoles(info.remote, token, { grants: nextGrants });
  await syncRepoRoleCache(env.DB, repo.slug, nextGrants);
}

async function doSetVisibility(env: WebEnv, actor: Agent, repoSlug: string, visibility: "public" | "private"): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such repo");
  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("write", 3600);
  const info = await artifactsRepo.info();
  const { meta, roles } = await readRepoMetaAndRoles(info.remote, token);
  if (!meta) throw new ApiError(404, "repo has no metadata yet");
  if (!repoAtLeast(repoRoleFor(roles, actor.username), "owner")) throw new ApiError(403, `${actor.username} is not an Owner of ${repoSlug}`);
  await writeRepoMeta(info.remote, token, { ...meta, policy: { ...meta.policy, visibility } });
  await updateRepoVisibility(env.DB, repo.slug, visibility);
}

/** Ownership transfer keeps the repo's URL (slug) unchanged -- the slug is frozen at creation time off the ORIGINAL owner's username, same as a GitHub repo's path staying put after a transfer within the same org would. The new owner gets an explicit "owner" grant in roles.json; the previous owner's own grant is left as-is (not stripped), so transferring doesn't silently revoke their access -- they can demote themselves separately via the roles list if that's what they want. */
async function doTransferOwnership(env: WebEnv, actor: Agent, repoSlug: string, newOwnerUsername: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such repo");
  const newOwner = await getAgent(env.DB, newOwnerUsername);
  if (!newOwner) throw new ApiError(404, "no such agent");
  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("write", 3600);
  const info = await artifactsRepo.info();
  const { meta, roles } = await readRepoMetaAndRoles(info.remote, token);
  if (!meta) throw new ApiError(404, "repo has no metadata yet");
  if (!repoAtLeast(repoRoleFor(roles, actor.username), "owner")) throw new ApiError(403, `${actor.username} is not an Owner of ${repoSlug}`);

  await writeRepoMeta(info.remote, token, { ...meta, owner: newOwner.username });
  const nextGrants = (roles?.grants ?? []).filter((g) => g.principal !== newOwner.username);
  nextGrants.push({ principal: newOwner.username, role: "owner", granted_by: actor.username, at: new Date().toISOString() });
  await writeRepoRoles(info.remote, token, { grants: nextGrants });
  await syncRepoRoleCache(env.DB, repo.slug, nextGrants);
  await updateRepoOwner(env.DB, repo.slug, newOwner.username);
}

async function doDeleteRepo(env: WebEnv, actor: Agent, repoSlug: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such repo");
  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("read", 120);
  const info = await artifactsRepo.info();
  const roles = await readRepoRoles(info.remote, token);
  if (!repoAtLeast(repoRoleFor(roles, actor.username), "owner")) throw new ApiError(403, `${actor.username} is not an Owner of ${repoSlug}`);
  await env.ARTIFACTS.delete(repo.artifacts_name);
  await deleteRepoRow(env.DB, repo.slug);
}

function doStub(env: WebEnv, artifactsName: string) {
  const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(artifactsName));
  return stub;
}

/** The root ("_repo") Lane's full history -- every ASK/ANSWER posted via doPostAsk or the engine's own protocol. Null if the repo has no root Lane yet (never had an Ask posted to it). Real `Lane` objects throughout (not a trimmed display type): claimableAsks (engine/workqueue.ts) needs the real shape (coordinators AND maintainers), and the DO already hands back exactly that. */
async function getRootLane(env: WebEnv, artifactsName: string): Promise<Lane | null> {
  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  return (await stub.callTool("lane_get", { repo: artifactsName, lane_id: "_repo" })) as Lane | null;
}

/** Every Lane in the repo, for the "Lanes" tab -- the full flattened cross-lane protocol feed (the "Protocol" tab) and the Work page's claimable-asks query are both derived from these same objects, not a second fetch. */
async function getAllLanes(env: WebEnv, artifactsName: string): Promise<Lane[]> {
  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  return (await stub.callTool("lane_list", { repo: artifactsName })) as Lane[];
}

interface ProtocolEvent {
  laneId: string;
  entry: HistoryEntry;
}

function flattenProtocol(lanes: Lane[]): ProtocolEvent[] {
  const events = lanes.flatMap((lane) => lane.history.map((entry) => ({ laneId: lane.id, entry })));
  return events.sort((a, b) => (a.entry.at < b.entry.at ? 1 : -1));
}

// Ladder tab: the repo's full Ladder tree, read via repeated
// ladder_read calls (the same shape engine/ladderRender.ts's
// collectLadder resolves locally, just driven through callTool since
// this runs in the Worker, not against a local clone). Only "ask"-
// thread children come back as bare {ref} stubs needing a follow-up
// call -- repo-wide/anchor kinds are already embedded inline. Capped
// so a pathological ask-thread depth can't turn one page load into
// hundreds of DO round-trips.
interface LadderNode {
  path: string;
  kind: string;
  summary: string;
  children: LadderNode[];
}

const LADDER_TAB_NODE_CAP = 300;

async function getLadderTree(env: WebEnv, artifactsName: string): Promise<LadderNode | null> {
  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  let remaining = LADDER_TAB_NODE_CAP;

  async function resolve(rung: EmbeddedRung): Promise<LadderNode> {
    remaining -= 1;
    const children: LadderNode[] = [];
    for (const child of rung.children) {
      if (remaining <= 0) break;
      if (isRef(child)) {
        const anchor = (await stub.callTool("ladder_read", { repo: artifactsName, path: child.ref })) as EmbeddedRung | null;
        children.push(anchor ? await resolve(anchor) : { path: child.ref, kind: "ask", summary: "[missing]", children: [] });
      } else {
        children.push(await resolve(child));
      }
    }
    return { path: rung.path, kind: rung.kind, summary: rung.summary, children };
  }

  const root = (await stub.callTool("ladder_read", { repo: artifactsName, path: "_repo" })) as EmbeddedRung | null;
  return root ? resolve(root) : null;
}

function renderLadderNode(node: LadderNode, depth = 0): string {
  const indent = "&nbsp;&nbsp;".repeat(depth);
  const self = `<li class="row">${indent}<span class="badge badge-pink">${esc(node.kind)}</span> <span class="mono">${esc(node.path)}</span> <span class="muted">${esc(node.summary)}</span></li>`;
  return [self, ...node.children.map((c) => renderLadderNode(c, depth + 1))].join("");
}

// --- Work: every claimable Ask across every repo the viewer can see,
// mirroring `zz work`'s own claimableAcrossRepos query -- same pure
// engine function (engine/workqueue.ts's claimableAsks), just fed Lane
// objects fetched via callTool instead of a local Backend. A repo a
// human never set up `~/.zz/config.json` for is still visible here
// (and vice versa): this reads from the same viewer-aware repo listing
// /explore uses (private repos excluded unless the viewer has a
// role), not a client-side config file.

interface ClaimableWorkItem {
  repoSlug: string;
  laneId: string;
  ask: AskEntry;
}

async function getClaimableForViewer(env: WebEnv, viewerUsername: string): Promise<ClaimableWorkItem[]> {
  const repos = await listRecentRepos(env.DB, 200, viewerUsername);
  const out: ClaimableWorkItem[] = [];
  for (const repo of repos) {
    const lanes = await getAllLanes(env, repo.artifacts_name);
    for (const lane of lanes) {
      for (const ask of claimableAsks(lane, viewerUsername)) {
        out.push({ repoSlug: repo.slug, laneId: lane.id, ask });
      }
    }
  }
  return out;
}

async function doClaimAsk(env: WebEnv, actor: Agent, repoSlug: string, laneId: string, askId: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such repo");
  const stub = doStub(env, repo.artifacts_name);
  await stub.configure(repo.artifacts_name);
  await stub.callTool("ask_claim", { repo: repo.artifacts_name, lane_id: laneId, ask_id: askId, actor: actor.username });
}

async function handleWorkPage(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");

  const items = await getClaimableForViewer(env, me.username);
  const rows = items
    .map(
      (it) => `<li class="stack">
        <div class="row"><a href="/${esc(it.repoSlug)}" class="mono" style="color:var(--pink)">${esc(it.repoSlug)}</a><span class="badge badge-muted">${esc(it.laneId)}</span><span class="badge badge-yellow">${esc(it.ask.kind)}</span></div>
        ${jsonBlock(it.ask.payload)}
        <form method="post" action="/work/claim" class="inline">
          <input type="hidden" name="repo_slug" value="${esc(it.repoSlug)}">
          <input type="hidden" name="lane_id" value="${esc(it.laneId)}">
          <input type="hidden" name="ask_id" value="${esc(it.ask.id)}">
          <button type="submit">Claim</button>
        </form>
      </li>`,
    )
    .join("");

  return layout(
    "Work",
    me,
    `${card(
      "Claimable",
      `<p class="hint">Every open Ask across every repo you can see that you're permitted to act on -- the same query \`zz work\` runs, just for a human clicking instead of an agent looping.</p>
       <ul class="list">${rows || '<li class="empty">Nothing claimable right now.</li>'}</ul>`,
    )}

     ${card(
       "Post an ask to a repo's root lane",
       `<form method="post" action="/work/ask" class="stack">
          <input name="repo_slug" placeholder="owner/repo-name" required>
          <textarea name="description" placeholder="what do you need done?" required></textarea>
          <button type="submit">Post ASK</button>
        </form>`,
     )}`,
  );
}

function workInstructions(repoSlug: string, laneId: string, askId: string, ask: AskEntry): string {
  if (ask.kind === "changeset_review") {
    return `<pre>zz review --repos ${esc(repoSlug)}</pre>
      <p class="hint">Walks you through every changeset_review Ask you can approve, one at a time -- approve, request changes, or skip.</p>`;
  }
  return `<pre>zz repo clone ${esc(repoSlug)}
cd ${esc(repoSlug.split("/").pop() ?? "repo")}
# ...edit files...
git add &lt;the files you changed&gt;
zz repo submit ${esc(repoSlug)} ${esc(laneId)} ${esc(askId)} --message "what you did"</pre>
    <p class="hint">Posts your changes for review and marks this Ask complete -- the same protocol sequence a scripted agent follows (changeset_review + submit_changeset, then a Maintainer's \`zz review\` and a coordinator's \`zz work\` merge it), just with content you wrote instead of generated.</p>`;
}

async function handleWorkClaimForm(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  const repoSlug = String(form.get("repo_slug") ?? "");
  const laneId = String(form.get("lane_id") ?? "");
  const askId = String(form.get("ask_id") ?? "");
  try {
    await doClaimAsk(env, me, repoSlug, laneId, askId);
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }

  const repo = await getRepoBySlug(env.DB, repoSlug);
  const lanes = repo ? await getAllLanes(env, repo.artifacts_name) : [];
  const resolvedAsk = lanes.find((l) => l.id === laneId)?.history.find((e): e is AskEntry => e.type === "ASK" && e.id === askId);

  return layout(
    "Claimed",
    me,
    `<div class="card stack">
       <p>Claimed <span class="badge badge-yellow">${esc(resolvedAsk?.kind ?? "?")}</span> on <a href="/${esc(repoSlug)}" class="mono" style="color:var(--pink)">${esc(repoSlug)}</a> (lane <span class="mono">${esc(laneId)}</span>).</p>
       ${resolvedAsk ? workInstructions(repoSlug, laneId, askId, resolvedAsk) : '<p class="hint">Could not load this Ask\'s details -- check the repo page\'s Asks tab.</p>'}
       <p><a href="/work">&larr; Back to Work</a></p>
     </div>`,
  );
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
    await stub.callTool("lane_propose", { repo: repo.artifacts_name, id: "_repo", name: repo.slug, objective: `the ${repo.slug} repository`, scope: ["**"], actor: repo.owner_username });
  }
  await stub.callTool("ask_post", { repo: repo.artifacts_name, lane_id: "_repo", kind: "work", from: actor.username, payload: { description } });
}

// --- Agent profile: /<username> is BOTH the public view (anyone) and
// the private, editable view (when you're logged in as that agent) --
// no separate /profile route. See migration 0003's header for why
// `username` is a frozen, stored column rather than recomputed.

interface RepoWithRole extends RepoRow {
  role: string;
}

async function handleAgentPage(username: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  const pageAgent = await getAgent(env.DB, username);
  if (!pageAgent) return new Response("no such agent", { status: 404 });

  if (me && me.username === pageAgent.username) return renderOwnProfile(me, env);
  return renderPublicProfile(pageAgent, request, env);
}

async function renderPublicProfile(agent: Agent, request: Request, env: WebEnv): Promise<Response> {
  const owned = await listReposOwnedBy(env.DB, agent.username);
  const visible: RepoRow[] = [];
  for (const r of owned) {
    const ctx = await getRepoAccessContext(r.slug, env);
    if (ctx && (await canReadRepo(request, env, ctx.meta, ctx.roles))) visible.push(r);
  }
  return layout(
    agent.username,
    await resolveRequestAgent(request, env),
    `${card(
       "Repos",
       `<ul class="list">${visible.map((r) => `<li><a href="/${esc(r.slug)}" class="mono" style="color:var(--pink)">${esc(r.slug)}</a>${r.description ? `<div class="muted">${esc(r.description)}</div>` : ""}</li>`).join("") || '<li class="empty">No public repos.</li>'}</ul>`,
     )}`,
  );
}

async function renderOwnProfile(me: Agent, env: WebEnv): Promise<Response> {
  const createdAgents = await listAgentsCreatedBy(env.DB, me.username);
  const allSelf = [me, ...createdAgents];
  const tokenLists = await Promise.all(allSelf.map((a) => listTokensForAgent(env.DB, a.username)));

  // One flat, unified list across you and every agent you manage --
  // no more "your tokens" vs "managed agents' tokens" as two separate
  // sub-UIs (per direct instruction: token management should not
  // distinguish you from the agents you manage).
  const tokenRows = allSelf
    .flatMap((a, i) => tokenLists[i].filter((t) => !t.revoked_at).map((t) => ({ agent: a, token: t })))
    .map(
      ({ agent, token }) =>
        `<li class="row"><b class="mono">${esc(agent.username)}</b> <span class="mono">${esc(token.id)}</span> <span class="muted">${token.last_used_at ? `last used ${esc(token.last_used_at)}` : "never used"}</span>
          <form method="post" action="/profile/tokens/${token.id}/revoke" class="inline"><button type="submit" class="danger">Revoke</button></form></li>`,
    )
    .join("");

  const [ownedRepos, sharedRepos] = await Promise.all([listReposOwnedBy(env.DB, me.username), listRepoRolesForAgent(env.DB, me.username)]);
  const repoRows: { repo: RepoRow; role: string }[] = [...ownedRepos.map((r) => ({ repo: r, role: "owner" })), ...sharedRepos.map((r) => ({ repo: r as RepoWithRole, role: (r as RepoWithRole).role }))];

  return layout(
    `${me.username} (you)`,
    me,
    `${card(
       "Credentials",
       `<p class="hint">You, and every agent you manage, share one token list -- not "yours" vs "theirs" in any authority sense, just one place to issue, rotate, or revoke whatever can authenticate as any of them.</p>
        <ul class="list">${tokenRows || '<li class="empty">No active tokens.</li>'}</ul>`,
       { addModal: "modal-add-token" },
     )}

     ${card(
       "Repos",
       `<ul class="list">${
         repoRows
           .map(({ repo, role }) => `<li class="row"><a href="/${esc(repo.slug)}" class="mono" style="color:var(--pink)">${esc(repo.slug)}</a>${roleBadge(role)}</li>`)
           .join("") || '<li class="empty">None yet.</li>'
       }</ul>`,
       { addModal: "modal-create-repo" },
     )}

     <dialog id="modal-add-token" class="modal"><div class="modal-body">
       <h3>Add a token</h3>
       <form method="post" action="/profile/tokens" class="stack">
         <p class="hint" style="margin:0">Pick an agent you manage, or type a new name to create one (and mint its first token in the same step).</p>
         ${agentAutocompleteField("agent", "agent name or existing agent", "add-token")}
         <div class="modal-actions">
           <button type="button" class="secondary" onclick="this.closest('dialog').close()">Cancel</button>
           <button type="submit">Add</button>
         </div>
       </form>
     </div></dialog>

     <dialog id="modal-create-repo" class="modal"><div class="modal-body">
       <h3>Create a repo</h3>
       <form method="post" action="/profile/repos" class="stack">
         <input name="name" placeholder="repo-name" required pattern="[A-Za-z0-9._-]+">
         <input name="description" placeholder="description">
         <select name="license">
           <option value="">No license</option>
           ${LICENSE_ORDER.map((k) => `<option value="${esc(k)}">${esc(LICENSES[k].name)}</option>`).join("")}
         </select>
         <div class="modal-actions">
           <button type="button" class="secondary" onclick="this.closest('dialog').close()">Cancel</button>
           <button type="submit">Create</button>
         </div>
       </form>
     </div></dialog>`,
  );
}

/** A single value covers both the earlier two actions (mint a token for an existing agent, or create a brand-new managed agent and mint its first token) -- matches the unified "+" modal: the username of an agent you already manage mints; anything else creates. */
async function handleTokenAddForm(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  const value = String(form.get("agent") ?? "").trim();
  try {
    const existing = await getAgent(env.DB, value);
    const { agent, token } = existing ? await doMintToken(env, me, existing.username) : await doCreateAgent(env, me, value);
    const zzId = `${agent.username}:${token}`;
    return layout(
      "New token",
      me,
      `<div class="card stack">
         <p>Token for <b class="mono">${esc(agent.username)}</b> -- copy it now, it won't be shown again:</p>
         <div class="clone-row"><pre>${esc(token)}</pre><button class="secondary icon-btn" data-copy="${esc(token)}" title="Copy">⧉</button></div>
         <p><a href="/${esc(me.username)}">&larr; Back to profile</a></p>
       </div>
       ${card(
         "Run zz work as this identity",
         `<p class="hint">From the same machine's \`zz login\` session, you don't need this at all -- <code>zz work --as ${esc(value)}</code> mints its own short-lived token automatically and revokes it on exit. This one's for a separate machine or a headless run with no login session:</p>
          <div class="clone-row"><pre>ZZ_ID="${esc(zzId)}"</pre><button class="secondary icon-btn" data-copy="${esc(`ZZ_ID="${zzId}"`)}" title="Copy">⧉</button></div>`,
       )}`,
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
    const owner = await getAgent(env.DB, token.agent_username);
    if (owner && (owner.username === me.username || owner.created_by === me.username)) await revokeAgentToken(env.DB, tokenId);
  }
  return redirect(`/${me.username}`);
}

async function handleRbacGrantForm(repoSlug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    await doRbacGrant(env, me, repoSlug, String(form.get("principal") ?? ""), String(form.get("role") ?? "reader") as RbacRole);
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
  return redirect(`/${repoSlug}/settings`);
}

async function handleRbacRevokeForm(repoSlug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    await doRevokeGrant(env, me, repoSlug, String(form.get("principal") ?? ""));
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
  return redirect(`/${repoSlug}/settings`);
}

async function handleCreateRepoForm(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    const repo = await doCreateRepo(env, me, String(form.get("name") ?? "").trim(), String(form.get("description") ?? "").trim() || null, String(form.get("license") ?? "").trim() || null);
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
  return redirect("/work");
}

async function handleVisibilityForm(repoSlug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    await doSetVisibility(env, me, repoSlug, String(form.get("visibility") ?? "public") as "public" | "private");
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
  return redirect(`/${repoSlug}/settings`);
}

async function handleTransferForm(repoSlug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    await doTransferOwnership(env, me, repoSlug, String(form.get("new_owner") ?? "").trim());
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
  return redirect(`/${repoSlug}/settings`);
}

async function handleDeleteRepoForm(repoSlug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  try {
    await doDeleteRepo(env, me, repoSlug);
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
  return redirect(`/${me.username}`);
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
    return json({ you: me, created: await listAgentsCreatedBy(env.DB, me.username) });
  });
}

/** Autocomplete backing for any "which agent" field (add-token, grant-role, transfer-ownership) -- searches every Agent known to zz, not just ones the caller created. The server-side authority check for what you're actually trying to DO with the chosen agent (mint a token, grant a role) still applies at the real action endpoint; this just helps you find the right username. */
async function handleApiSearchAgents(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    await requireApiAgent(request, env);
    const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if (!q) return json({ agents: [] });
    return json({ agents: await searchAgents(env.DB, q, 10) });
  });
}

async function handleApiMintToken(username: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const { agent, token } = await doMintToken(env, me, username);
    return json({ agent, token }, 201);
  });
}

// Revokes whichever token authenticated THIS request -- no id needed
// client-side, which is exactly the point: a CLI session that just
// minted a token for one `--as <name>` session (lib/identity.ts) can
// clean up after itself at exit using nothing but the token it
// already has in hand, with no separate id to have tracked. Scoped to
// "your own" by construction (the bearer token IS the identity being
// revoked), so no additional authority check is needed the way
// handleRevokeTokenForm's id-based version needs (owner === you, or
// you created it).
async function handleApiRevokeSelf(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const bearer = readBearerToken(request);
    if (!bearer) throw new ApiError(401, "no bearer token presented");
    const token = await findActiveAgentToken(env.DB, hashAgentToken(bearer));
    if (!token) throw new ApiError(404, "token not found or already revoked");
    await revokeAgentToken(env.DB, token.id);
    return json({ ok: true });
  });
}

async function handleApiCreateRepo(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { name?: string; description?: string; owner_username?: string; license?: string };
    const owner = !body.owner_username || body.owner_username === me.username ? me : await getAgent(env.DB, body.owner_username);
    if (!owner || (owner.username !== me.username && owner.created_by !== me.username)) throw new ApiError(403, "not yours to create repos as");
    const repo = await doCreateRepo(env, owner, (body.name ?? "").trim(), body.description?.trim() || null, body.license ?? null);
    return json(repo, 201);
  });
}

async function handleApiListRepos(request: Request, env: WebEnv): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const viewer = await resolveRequestAgent(request, env);
  const repos = q ? await searchRepos(env.DB, q, 50, viewer?.username ?? null) : await listRecentRepos(env.DB, 50, viewer?.username ?? null);
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

// Generic passthrough to MaintainerDO.callTool -- the same mechanism
// the web app's own doPostAsk/doRbacGrant etc. use internally, just
// exposed directly so `zz work` (CLI) can drive the real protocol
// (ask_claim, ask_answer, commit_changeset, ladder_write_rung, ...)
// against a remote repo without the CLI needing its own copy of any
// of that logic. No repo-level RBAC gate here beyond "authenticated as
// someone real" -- every tool already enforces its own Lane-level
// rules (coordinators/maintainers/ASK_SCOPE) server-side, the same as
// it does called from the web app or MaintainerDO's existing routes.
// The one thing checked here: args.actor/args.from, when present,
// must equal the authenticated caller's own username -- otherwise a
// valid token for Agent A could act as Agent B just by naming it in
// the payload, which no tool-level check catches (they trust the
// caller-supplied actor/from field completely, same as the local CLI
// always has).
async function handleApiCallTool(slug: string, toolName: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const repo = await getRepoBySlug(env.DB, slug);
    if (!repo) throw new ApiError(404, "no such repo");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    for (const field of ["actor", "from"]) {
      if (field in body && body[field] !== me.username) throw new ApiError(403, `${field} must be your own username (${me.username}) -- a token only acts as the agent it belongs to`);
    }
    const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(repo.artifacts_name));
    await stub.configure(repo.artifacts_name);
    try {
      const result = await stub.callTool(toolName, { ...body, repo: repo.artifacts_name });
      return json({ result });
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
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

async function handleApiShard(slug: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { task?: string };
    if (!body.task?.trim()) throw new ApiError(400, "task is required");
    const row = await ensureShard(env, slug, me, body.task.trim());
    return json(row, 201);
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

async function handleApiExploreSearch(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return json({ repos: [], agents: [] });
  return json(await searchExplore(env.DB, q, 8, me?.username ?? null));
}

// --- Ladder search: "ecosystem-wide intelligence" you can actually
// query, not just generate. Deliberately NOT a per-repo tool routed
// through one repo's MaintainerDO (every other tool is) -- this reads
// across every repo at once, which is a D1 concern (the one place
// that's already cross-repo infrastructure, same as searchRepos/
// searchExplore), not a single repo's Ladder/git-notes concern.
async function handleApiLadderSearch(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await resolveRequestAgent(request, env);
    const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if (!q) return json({ hits: [] });
    const limit = Math.min(Number(new URL(request.url).searchParams.get("limit")) || 10, 25);
    const hits = await searchLadderIndex(env.DB, q, limit, me?.username ?? null);
    return json({ hits });
  });
}

function repoResultHtml(r: RepoRow): string {
  return `<li class="row"><span class="badge badge-pink">REPO</span> <a href="/${esc(r.slug)}" class="name mono">${esc(r.slug)}</a>${r.description ? ` <span class="desc muted">${esc(r.description)}</span>` : ""}</li>`;
}

function agentResultHtml(a: Agent): string {
  return `<li class="row"><span class="badge badge-cyan">USER</span> <a href="/${esc(a.username)}" class="mono">${esc(a.username)}</a>${a.display_name && a.display_name !== a.username ? ` <span class="desc muted">${esc(a.display_name)}</span>` : ""}</li>`;
}

// A Ladder hit is a fundamentally different shape than a repo/user
// match: it's not "here's a thing", it's "here's something SAID about
// a specific file, anchored to a specific commit" -- so it gets both
// links (file content as it is now, and the commit that summary is
// actually anchored to), not just one link like the other two types.
function ladderResultHtml(h: LadderSearchHit): string {
  const fileLink = `<a href="/${esc(h.repo_slug)}/blob/${esc(h.path)}" class="mono">${esc(h.path)}</a>`;
  const commitLink = h.commit_sha ? ` -- <a href="/${esc(h.repo_slug)}/commit/${esc(h.commit_sha)}" class="mono">${esc(h.commit_sha.slice(0, 8))}</a>` : "";
  return `<li class="row"><span class="badge badge-yellow">LADDER</span> <span class="desc">${esc(h.summary)}</span><br><span class="muted">in <a href="/${esc(h.repo_slug)}">${esc(h.repo_slug)}</a>: ${fileLink}${commitLink}</span></li>`;
}

async function handleExplore(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  let bodyHtml: string;
  if (!q) {
    // No query: the MRU repo browse list, unchanged -- heterogeneous
    // results are a SEARCH behavior, not something to force onto
    // plain browsing where "recently active repos" is the actually
    // useful default view.
    const repos = await listRecentRepos(env.DB, 50, me?.username ?? null);
    bodyHtml = `<ul class="list">${repos.map(repoResultHtml).join("") || '<li class="empty">No repos yet.</li>'}</ul>`;
  } else {
    const { repos, agents, ladderHits } = await searchExplore(env.DB, q, 25, me?.username ?? null);
    const rows = [...repos.map(repoResultHtml), ...agents.map(agentResultHtml), ...ladderHits.map(ladderResultHtml)];
    bodyHtml = `<ul class="list">${rows.join("") || '<li class="empty">No matches.</li>'}</ul>`;
  }

  return layout(
    "Explore",
    me,
    `<div class="ac-wrap" style="margin-bottom:1.25rem">
       <form method="get" action="/explore" class="field-row">
         <input name="q" value="${esc(q)}" placeholder="search repos, users, and the Ladder" autocomplete="off" data-explore-search="explore-ac-box" style="flex:3">
         <button type="submit">Search</button>
       </form>
       <div id="explore-ac-box" class="ac-list" hidden></div>
     </div>
     ${bodyHtml}`,
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
// This is the one function every repo-viewing route (handleRepoPage,
// handleBlob, handleCommit, handleArchive, handleDownload, ...) calls
// first, so its own cost sets the floor for all of them. It used to
// do THREE separate full git fetches of the same zz-meta branch on
// every single call: one hidden inside ensureMeta's own existence
// check (readRepoMeta internally, to decide whether to no-op), plus
// two more for meta/roles themselves. For a repo that's already been
// viewed once (i.e. almost always), only the third pair was ever
// doing real work -- now it's one fetch total, and ensureMeta (a real
// write, only for a repo's actual first-ever access) only runs on the
// rare path where that one read comes back empty.
async function getRepoAccessContext(slug: string, env: WebEnv): Promise<{ repoRow: RepoRow; meta: Awaited<ReturnType<typeof readRepoMeta>>; roles: Awaited<ReturnType<typeof readRepoRoles>> } | null> {
  const repoRow = await getRepoBySlug(env.DB, slug);
  if (!repoRow) return null;
  using repo = await env.ARTIFACTS.get(repoRow.artifacts_name);
  const token = await repo.createToken("read", 300);
  const info = await repo.info();
  let { meta, roles } = await readRepoMetaAndRoles(info.remote, token);
  if (!meta) {
    await ensureMeta(info.remote, token, { description: repoRow.description ?? "", owner: repoRow.owner_username });
    ({ meta, roles } = await readRepoMetaAndRoles(info.remote, token));
  }
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
  return token.agent_username;
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
  const principals = [me?.username, gitPrincipal].filter((p): p is string => !!p);
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

  // Started here, awaited down below where they're actually used --
  // neither depends on anything from the git-content reads that
  // follow (they only need artifacts_name, already in hand), so
  // there's no reason the DO/Ladder round-trip should wait for the
  // Artifacts round-trip to finish first, or vice versa.
  const lanesAndLadder = Promise.all([getAllLanes(env, repoRow.artifacts_name), getLadderTree(env, repoRow.artifacts_name)]);

  using repo = await env.ARTIFACTS.get(repoRow.artifacts_name);
  const info = await repo.info();
  // One log() call, not two -- commits[0] is already HEAD, so a
  // separate limit:1 call just to get `head` was a second full
  // round-trip for a fact the limit:30 call already carries.
  const commits = await repo.log({ ref: info.defaultBranch, limit: 30 });
  const head = commits[0] ?? null;
  const tree: TreeEntry[] = head ? ((await repo.readTree(head.treeHash)) ?? []) : [];
  const readme = head ? await findReadme(repo, tree) : null;

  const fileListHtml = tree
    .map(
      (e) =>
        `<li class="row">${e.type === "tree" ? "📁" : "📄"} ${e.type !== "tree" ? `<a href="${origin}/${esc(slug)}/blob/${esc(e.name)}" class="mono">${esc(e.name)}</a>` : `<span class="mono">${esc(e.name)}</span>`}</li>`,
    )
    .join("");

  const rolesHtml = (roles?.grants ?? []).map((g) => `<span class="badge badge-${ROLE_BADGE_VARIANT[g.role] ?? "muted"} mono">${esc(g.principal)}: ${esc(g.role)}</span>`).join(" ");
  const visibility = meta?.policy.visibility ?? "public";
  const isOwner = !!me && repoAtLeast(repoRoleFor(roles, me.username), "owner");

  const [lanes, ladder] = await lanesAndLadder;
  const rootLane = lanes.find((l) => l.id === "_repo") ?? null;

  const asksHtml = (rootLane?.history ?? [])
    .slice()
    .reverse()
    .map((e) => {
      if (e.type === "ASK") return `<li class="stack"><div class="row"><span class="badge badge-yellow">ASK</span> ${esc(e.kind ?? "?")} from ${esc(e.from ?? "?")} <span class="muted">${esc(e.at)}</span></div>${jsonBlock(e.payload)}</li>`;
      if (e.type === "ANSWER") return `<li class="row"><span class="badge badge-green">ANSWER</span> ${esc(e.action ?? "?")} by ${esc(e.from ?? "?")} on ${esc(e.ask ?? "?")} <span class="muted">${esc(e.at)}</span></li>`;
      return `<li class="row"><span class="badge badge-cyan">INSIGHT</span> ${esc(e.text)} <span class="muted">${esc(e.at)}</span></li>`;
    })
    .join("");

  const lanesHtml = lanes
    .map((l) => `<li class="row"><span class="mono">${esc(l.id)}</span> <span class="badge badge-${LANE_STATUS_BADGE_VARIANT[l.status] ?? "muted"}">${esc(l.status)}</span> <span class="muted">coord: ${esc(l.coordinators?.join(", ") ?? "")}</span></li>`)
    .join("");

  // "Activity" -- the closest thing a static page has to the CLI's own
  // activity feed: there's no server-side record of raw tool-call
  // traffic (the TUI's activity tab reads a live process's in-memory
  // LogBuffer, which only exists while `zz work` is actually running),
  // so this is the full persisted protocol trail instead, styled as a
  // dense log feed rather than badge-decorated rows to read the way a
  // live feed does.
  const logFeedHtml = flattenProtocol(lanes)
    .slice(0, 150)
    .map(({ laneId, entry: e }) => {
      const cls = e.type === "ASK" ? "t-ask" : e.type === "ANSWER" ? "t-answer" : "t-insight";
      const rest = e.type === "ASK" ? `${esc(e.kind ?? "?")} from ${esc(e.from ?? "?")}` : e.type === "ANSWER" ? `${esc(e.action ?? "?")} by ${esc(e.from ?? "?")} on ${esc(e.ask ?? "?")}` : esc(e.text);
      return `<div class="log-line"><span class="${cls}">${esc(e.type)}</span>&nbsp;&nbsp;<span class="muted">${esc(laneId)}</span>&nbsp;&nbsp;${rest}&nbsp;&nbsp;<span class="muted">${esc(e.at)}</span></div>`;
    })
    .join("");

  const commitsHtml = commits
    .map((c) => `<li class="row"><a href="/${esc(slug)}/commit/${esc(c.hash)}" class="mono">${esc(c.hash.slice(0, 8))}</a> ${esc(c.message.split("\n")[0])} <span class="muted">${esc(c.author.name)} ${esc(new Date(c.authoredAt * 1000).toISOString())}</span></li>`)
    .join("");

  const fileTabs = [
    readme ? { id: "readme", label: "README", html: `<div class="md">${renderMarkdown(readme)}</div>` } : null,
    { id: "ladder", label: "Ladder", html: `<ul class="list">${ladder ? renderLadderNode(ladder) : '<li class="empty">No Ladder content yet.</li>'}</ul>` },
    { id: "files", label: "Files", html: `<ul class="list">${fileListHtml || '<li class="empty">Empty repo.</li>'}</ul>` },
    { id: "commits", label: "Commits", html: `<ul class="list">${commitsHtml || '<li class="empty">No commits yet.</li>'}</ul>` },
  ].filter((t): t is { id: string; label: string; html: string } => t !== null);

  const activityTabs = [
    { id: "activity", label: "Activity", html: `<div class="log-feed">${logFeedHtml || '<div class="empty">No activity yet.</div>'}</div>` },
    { id: "asks", label: "Asks", html: `<ul class="list">${asksHtml || '<li class="empty">No Asks posted yet.</li>'}</ul>` },
    { id: "lanes", label: "Lanes", html: `<ul class="list">${lanesHtml || '<li class="empty">No Lanes yet.</li>'}</ul>` },
  ];

  const tabGroup = (groupId: string, tabs: { id: string; label: string; html: string }[]): string => `
    <div class="card" data-tabs>
      <div class="tab-bar">${tabs.map((t, i) => `<button type="button" class="tab-btn${i === 0 ? " active" : ""}" data-target="${groupId}-${t.id}">${esc(t.label)}</button>`).join("")}</div>
      ${tabs.map((t, i) => `<div id="${groupId}-${t.id}" class="tab-panel"${i === 0 ? "" : " hidden"}>${t.html}</div>`).join("")}
    </div>`;

  const cloneUrl = `${origin}/${slug}`;
  const workCmd = `zz work --repos ${slug}`;

  return layout(
    slug,
    me,
    `<div class="card">
       <div class="card-head">
         <div class="row">${rolesHtml}</div>
         ${isOwner ? `<a href="/${esc(slug)}/settings"><button class="icon-btn" title="Settings">⚙</button></a>` : ""}
       </div>
       <p>${esc(meta?.description ?? repoRow.description ?? "")}</p>
       <div class="clone-row">
         <pre>git clone ${esc(cloneUrl)}</pre>
         <button class="secondary icon-btn" data-copy="${esc(`git clone ${cloneUrl}`)}" title="Copy clone command">⧉</button>
         <a href="${origin}/${esc(slug)}/archive.zip"><button class="secondary">Download .zip</button></a>
       </div>
       <p class="hint">To push: issue yourself (or a managed agent) a token on <a href="${me ? `/${esc(me.username)}` : "/login"}">your profile</a> (needs at least Maintainer). <code>zz repo clone ${esc(slug)}</code> does this automatically when logged in via the CLI.</p>
       <div class="clone-row">
         <pre>${esc(workCmd)}</pre>
         <button class="secondary icon-btn" data-copy="${esc(workCmd)}" title="Copy">⧉</button>
       </div>
       <p class="hint">Join as a worker: run that from a terminal logged in via <code>zz login</code> to pick up and work this repo's Asks, same as any other agent.</p>
     </div>

     ${tabGroup("files", fileTabs)}
     ${tabGroup("act", activityTabs)}`,
    { titleHtml: `<span class="badge badge-${visibility === "private" ? "red" : "muted"}">${esc(visibility)}</span>` },
  );
}

async function handleRepoSettings(slug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("no such repo", { status: 404 });
  const { meta, roles } = ctx;
  if (!repoAtLeast(repoRoleFor(roles, me.username), "owner")) return new Response("Owners only", { status: 403 });

  const roleRows = (roles?.grants ?? [])
    .map(
      (g) => `<li class="row">
        <span class="mono">${esc(g.principal)}</span>
        <form method="post" action="/${esc(slug)}/settings/roles" class="row inline">
          <input type="hidden" name="principal" value="${esc(g.principal)}">
          <select name="role" class="role-select" disabled>
            ${(["owner", "maintainer", "contributor", "reader"] as const).map((r) => `<option value="${r}"${r === g.role ? " selected" : ""}>${r}</option>`).join("")}
          </select>
          <button type="button" class="secondary" onclick="this.previousElementSibling.disabled=false;this.nextElementSibling.hidden=false;this.hidden=true">Edit</button>
          <button type="submit" class="secondary" hidden>Save</button>
        </form>
        <form method="post" action="/${esc(slug)}/settings/roles/revoke" class="inline">
          <input type="hidden" name="principal" value="${esc(g.principal)}">
          <button type="submit" class="danger">Revoke</button>
        </form>
      </li>`,
    )
    .join("");

  const visibility = meta?.policy.visibility ?? "public";

  return layout(
    `${slug} settings`,
    me,
    `${card(
      "Roles",
      `<ul class="list">${roleRows || '<li class="empty">No grants yet.</li>'}</ul>`,
      { addModal: "modal-add-role" },
    )}

     ${card(
       "Visibility",
       `<p class="hint">Public repos are readable by anyone; private repos need an explicit role grant above to even view.</p>
        <form method="post" action="/${esc(slug)}/settings/visibility" class="row">
          <select name="visibility"><option value="public"${visibility === "public" ? " selected" : ""}>public</option><option value="private"${visibility === "private" ? " selected" : ""}>private</option></select>
          <button type="submit" class="secondary">Save</button>
        </form>`,
     )}

     ${card(
       "Danger zone",
       `<div class="stack">
          <form method="post" action="/${esc(slug)}/settings/transfer" class="field-row">
            ${agentAutocompleteField("new_owner", "new owner (agent name or id)", "transfer")}
            <button type="submit" class="danger">Transfer ownership</button>
          </form>
          <form method="post" action="/${esc(slug)}/settings/delete" onsubmit="return confirm('Permanently delete ${esc(slug).replace(/'/g, "\\'")}? This cannot be undone.')">
            <button type="submit" class="danger">Delete repo</button>
          </form>
        </div>`,
       { extraClass: "danger-zone" },
     )}

     <dialog id="modal-add-role" class="modal"><div class="modal-body">
       <h3>Add a role</h3>
       <form method="post" action="/${esc(slug)}/settings/roles" class="stack">
         ${agentAutocompleteField("principal", "agent name or id", "add-role")}
         <select name="role"><option>owner</option><option>maintainer</option><option selected>contributor</option><option>reader</option></select>
         <div class="modal-actions">
           <button type="button" class="secondary" onclick="this.closest('dialog').close()">Cancel</button>
           <button type="submit">Grant</button>
         </div>
       </form>
     </div></dialog>`,
  );
}

// A deliberately minimal commit permalink -- message/author/date and
// the tree at that commit, each file linking to its current (HEAD)
// blob, not a full historical diff view. Exists specifically so a
// Ladder search hit (handleApiLadderSearch) has somewhere real to
// send its "commit" link, not just its "file" link -- a rung's
// summary is anchored to a commit, and that anchor deserves its own
// permalink the way GitHub's does, even in this minimal form.
async function handleCommit(slug: string, sha: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("no such repo", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.roles))) return new Response("no such repo", { status: 404 });
  const me = await resolveRequestAgent(request, env);

  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  const info = await repo.info();
  const commit = await repo.readCommit(sha);
  if (!commit) return new Response("no such commit", { status: 404 });
  const tree: TreeEntry[] = (await repo.readTree(commit.treeHash)) ?? [];

  // Forward/back through the log: a commit doesn't know its own newer
  // neighbor natively (only `parents`, which only ever points older),
  // so finding "newer" means walking the first-parent chain from HEAD
  // and noting whichever commit came right before this one. Bounded,
  // not a full history walk -- a commit older than this window only
  // gets a "back" link (via its own `parents[0]`), not a "forward" one;
  // fine at this project's scale, same spirit as the Commits tab's own
  // 30-commit cap.
  const log = await repo.log({ ref: info.defaultBranch, limit: 1000 });
  const i = log.findIndex((c) => c.hash === sha);
  const newer = i > 0 ? log[i - 1] : null;
  const older: string | null = i >= 0 && i < log.length - 1 ? log[i + 1].hash : (commit.parents[0] ?? null);

  const fileListHtml = tree
    .map((e) => `<li class="row">${e.type === "tree" ? "📁" : "📄"} ${e.type !== "tree" ? `<a href="/${esc(slug)}/blob/${esc(e.name)}" class="mono">${esc(e.name)}</a>` : `<span class="mono">${esc(e.name)}</span>`}</li>`)
    .join("");

  const navHtml = `<div class="commit-nav">
    ${older ? `<a href="/${esc(slug)}/commit/${esc(older)}" class="mono">&larr; prev ${esc(older.slice(0, 8))}</a>` : "<span></span>"}
    ${newer ? `<a href="/${esc(slug)}/commit/${esc(newer.hash)}" class="mono">next ${esc(newer.hash.slice(0, 8))} &rarr;</a>` : "<span></span>"}
  </div>`;

  return layout(
    sha.slice(0, 8),
    me,
    `<div class="card">
      <h2>Commit</h2>
      <p class="mono">${esc(sha)}</p>
      <p>${esc(commit.message)}</p>
      <p class="muted">${esc(commit.author.name)} &lt;${esc(commit.author.email)}&gt; -- ${esc(new Date(commit.authoredAt * 1000).toISOString())}</p>
      ${navHtml}
    </div>
    <div class="card">
      <h2>Tree at this commit</h2>
      <ul class="list">${fileListHtml || '<li class="empty">Empty.</li>'}</ul>
    </div>`,
    { titleHtml: ` \xb7 <a href="/${esc(slug)}">${esc(slug)}</a>` },
  );
}

/** The file's actual bytes, unchanged from what /blob/ used to serve directly -- the viewer's download button and anything else that wants the real file content (not an HTML page) points here now. */
async function handleDownload(slug: string, path: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("not found", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.roles))) return new Response("not found", { status: 404 });
  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  const info = await repo.info();
  const blob = await repo.readFile({ ref: info.defaultBranch, path });
  if (!blob) return new Response("not found", { status: 404 });
  return new Response(blob, { headers: { "content-type": blob.type || "application/octet-stream" } });
}

// highlight.js's language-detection aliases are mostly just the file
// extension already -- this only needs to cover the handful where
// they genuinely differ.
const HLJS_LANG_BY_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", jsx: "javascript",
  py: "python", rb: "ruby", rs: "rust", sh: "bash", yml: "yaml",
  md: "markdown", cs: "csharp", kt: "kotlin",
  txt: "plaintext",
};

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8000);
  for (const b of sample) if (b === 0) return true;
  return false;
}

/** The file viewer page: syntax-highlighted (via highlight.js from cdnjs -- a real CDN dependency, not hand-rolled, since this is a normal deployed website, not a sandboxed Artifact), line-numbered, with a header (repo, latest commit, path, download). GitHub's /blob/ convention -- this is the page a file link lands on; /download/ is the actual bytes now. */
async function handleBlob(slug: string, path: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("not found", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.roles))) return new Response("not found", { status: 404 });
  const me = await resolveRequestAgent(request, env);

  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  const info = await repo.info();
  const [blob, [head]] = await Promise.all([repo.readFile({ ref: info.defaultBranch, path }), repo.log({ ref: info.defaultBranch, limit: 1 })]);
  if (!blob) return new Response("not found", { status: 404 });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  const headerHtml = `<div class="blob-header">
    <a href="/${esc(slug)}">${esc(slug)}</a>
    ${head ? ` @ <a href="/${esc(slug)}/commit/${esc(head.hash)}" class="mono">${esc(head.hash.slice(0, 8))}</a>` : ""}
    <a href="/${esc(slug)}/download/${esc(path)}" class="download-btn" download>Download</a>
  </div>`;

  if (looksBinary(bytes)) {
    return layout(path, me, `${headerHtml}<div class="card">Binary file not shown.</div>`);
  }

  const text = new TextDecoder().decode(bytes);
  // No extension at all (LICENSE, Dockerfile, Makefile, ...) -- hljs
  // treats an empty/unrecognized language class as a signal to run
  // its own auto-detection heuristic instead of rendering plain text,
  // which is exactly the wrong behavior for a file with no real
  // language. "plaintext" is a real hljs language that just renders
  // the text unhighlighted.
  const lang = ext ? (HLJS_LANG_BY_EXT[ext] ?? ext) : "plaintext";
  const codeHtml = `<pre><code id="blob-code" class="language-${esc(lang)}">${esc(text)}</code></pre>`;

  return layout(
    path,
    me,
    `${headerHtml}
     <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/atom-one-dark.min.css">
     <div class="blob-body">${codeHtml}</div>
     <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
     <script src="https://cdnjs.cloudflare.com/ajax/libs/highlightjs-line-numbers.js/2.8.0/highlightjs-line-numbers.min.js"></script>
     <script>
       var block = document.getElementById('blob-code');
       hljs.highlightElement(block);
       hljs.lineNumbersBlock(block);
     </script>`,
  );
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
    await touchRepoUpdatedAt(env.DB, ctx.repoRow.slug).catch(() => {});
  }
  return response;
}

// --- Dispatch ---

/** Returns null for any path this module doesn't own, so index.ts can fall through to its existing diagnostic routes. */
export async function handleWebRequest(request: Request, env: WebEnv): Promise<Response | null> {
  const url = new URL(request.url);
  // Decoded once, up front: a username can contain "[", "]", "@" --
  // none of those are in the WHATWG URL spec's path percent-encode
  // set, so a conformant browser leaves them literal in `pathname`
  // (confirmed live: a route built from `agent.username` works as-is).
  // But a client that DOES percent-encode them anyway (confirmed live:
  // `encodeURIComponent` on a bracketed username, which some CLI/API
  // call sites reasonably reach for) would otherwise 404 forever,
  // since every lookup below (getRepoBySlug, getAgent, ...)
  // compares against the literal, undecoded form stored in D1.
  // Decoding here once means every route matches either form the same
  // way, instead of every individual call site needing to know which
  // encoding its particular caller happened to use.
  const path = decodeURIComponent(url.pathname);
  const origin = url.origin;

  if (path === "/login") return handleLogin(request);
  if (path === "/logout") return handleLogout(request, env);
  if (path === "/auth/start/cloudflare") return handleAuthStart("cloudflare", request, env);
  if (path === "/auth/start/google") return handleAuthStart("google", request, env);
  if (path === "/auth/callback/cloudflare") return handleAuthCallback("cloudflare", request, env);
  if (path === "/auth/callback/google") return handleAuthCallback("google", request, env);
  // /profile is kept only as a convenience redirect to your own
  // /<username> page -- see that handler's header for why there's no
  // separate profile route anymore (one route, public or editable
  // depending on who's looking).
  if (path === "/profile" && request.method === "GET") {
    const me = await resolveRequestAgent(request, env);
    return me ? redirect(`/${me.username}`) : redirect("/login");
  }
  if (path === "/profile/tokens" && request.method === "POST") return handleTokenAddForm(request, env);
  if (path === "/work/ask" && request.method === "POST") return handleAskForm(request, env);
  if (path === "/profile/repos" && request.method === "POST") return handleCreateRepoForm(request, env);
  {
    const m = path.match(/^\/profile\/tokens\/([^/]+)\/revoke$/);
    if (m && request.method === "POST") return handleRevokeTokenForm(m[1], request, env);
  }
  if (path === "/explore") return handleExplore(request, env);
  if (path === "/work" && request.method === "GET") return handleWorkPage(request, env);
  if (path === "/work/claim" && request.method === "POST") return handleWorkClaimForm(request, env);
  if (path === "/api/explore/search" && request.method === "GET") return handleApiExploreSearch(request, env);
  if (path === "/api/ladder/search" && request.method === "GET") return handleApiLadderSearch(request, env);

  // --- JSON API (CLI/agent parity with everything above) ---
  if (path === "/api/login/start" && request.method === "POST") return handleApiLoginStart(request, env);
  if (path === "/api/login/poll" && request.method === "GET") return handleApiLoginPoll(request, env);
  if (path === "/api/me" && request.method === "GET") return handleApiMe(request, env);
  if (path === "/api/me/revoke" && request.method === "POST") return handleApiRevokeSelf(request, env);
  if (path === "/api/agents" && request.method === "POST") return handleApiCreateAgent(request, env);
  if (path === "/api/agents" && request.method === "GET") return handleApiListAgents(request, env);
  if (path === "/api/agents/search" && request.method === "GET") return handleApiSearchAgents(request, env);
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
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/shard$/);
    if (m && request.method === "POST") return handleApiShard(`${m[1]}/${m[2]}`, request, env);
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
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/tools\/([^/]+)$/);
    if (m && request.method === "POST") return handleApiCallTool(`${m[1]}/${m[2]}`, m[3], request, env);
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
    const m = path.match(/^\/([^/]+)\/([^/]+)\/download\/(.+)$/);
    if (m) return handleDownload(`${m[1]}/${m[2]}`, m[3], request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]+)$/);
    if (m) return handleCommit(`${m[1]}/${m[2]}`, m[3], request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/settings$/);
    if (m && request.method === "GET") return handleRepoSettings(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/settings\/roles$/);
    if (m && request.method === "POST") return handleRbacGrantForm(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/settings\/roles\/revoke$/);
    if (m && request.method === "POST") return handleRbacRevokeForm(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/settings\/visibility$/);
    if (m && request.method === "POST") return handleVisibilityForm(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/settings\/transfer$/);
    if (m && request.method === "POST") return handleTransferForm(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/settings\/delete$/);
    if (m && request.method === "POST") return handleDeleteRepoForm(`${m[1]}/${m[2]}`, request, env);
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
  {
    const m = path.match(/^\/([^/]+)$/);
    if (m && request.method === "GET") return handleAgentPage(m[1], request, env);
  }

  return null;
}

export { upsertRepo, type RepoRow, type Agent };
