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
import { registerGuardianName, setGuardianContactEmail, registerManagedGuardianIdentity, reissueGuardianLoginSecret, rotateGuardianKey, GUARDIAN_NAME_RE } from "./guardianClient.js";
import { parseGuardianIdentifier, buildGuardianAuthorizeUrl, exchangeGuardianCode, currentGuardians } from "./guardianOidc.js";
import type { MaintainerDO } from "./MaintainerDO.js";
// Artifacts/ArtifactsRepo are ambient globals from @cloudflare/workers-types
// (no import needed/possible -- see cloudflareGitBackend.ts's header for
// why a module-level import of these resolves wrong).
import {
  type Agent,
  type RepoRow,
  type LadderSearchHit,
  type LaneRow,
  createAgent,
  createAgentIdentity,
  createAgentToken,
  setAgentOwnName,
  createCliLoginSession,
  createSession,
  deleteAgentIdentity,
  deleteRepoRow,
  deleteSession,
  findActiveAgentToken,
  findAgentIdentity,
  agentsCreatedByStillExist,
  deleteAgent,
  fulfillCliLoginSession,
  getAgent,
  getAgentByEmail,
  getAgentToken,
  listAgentIdentities,
  getRepoBySlug,
  getRepoRoleForPrincipal,
  getValidSession,
  isTrackingRepo,
  listAgentsCreatedBy,
  listLanesForPrincipal,
  listMyRepos,
  listRecentLanes,
  findReposByLaneId,
  listLanesByOrigin,
  listRecentRepos,
  listRepoRolesForAgent,
  listReposOwnedBy,
  listShardsOf,
  listTokensForAgent,
  pollAndConsumeCliLoginSession,
  refreshAgentProfile,
  revokeAgentToken,
  searchAgents,
  searchExplore,
  searchLadderIndex,
  searchRepos,
  setIngestStatus,
  shortId,
  syncRepoRoleCache,
  touchAgentToken,
  touchRepoUpdatedAt,
  trackRepo,
  untrackRepo,
  updateIdentityTokens,
  updateRepoOwner,
  updateRepoShardOf,
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
import { ensureMeta, readRepoMeta, readRepoMetaAndRoles, readRepoRoles, repoAtLeast, repoRoleFor, writeRepoRoles, writeRepoMeta, type RbacRole, type RepoRoles } from "./repoMeta.js";
import { LICENSES, LICENSE_ORDER, type LicenseOption } from "./licenses.js";
import { isRef, type EmbeddedRung } from "../../engine/ladderNotes.js";
import { REPO_RUNG_PATH, type Rung } from "../../engine/ladder.js";
import type { ResolvedRung } from "../../engine/ladderRender.js";
import { claimableAsks, claimHolder } from "../../engine/workqueue.js";
import type { AnswerEntry, AskEntry, HistoryEntry, InsightEntry, Lane, RepoPolicy } from "../../engine/types.js";
import { DEFAULT_REPO_POLICY, normalizePolicy } from "../../engine/policy.js";
import { ORIGIN_LANE_ID, laneHasOwner, laneHasCoordinatorOrAbove, laneHasAnyGrant } from "../../engine/lane.js";

export interface WebEnv extends OAuthEnv {
  ARTIFACTS: Artifacts;
  DB: D1Database;
  MAINTAINER_DO: DurableObjectNamespace<MaintainerDO>;
  // Service binding to zz's own did:guardian registrar Worker -- see
  // guardianClient.ts/guardianOidc.ts's own fetcherFor() for why a plain
  // fetch() to it (same zone, different Worker) isn't used instead.
  GUARDIAN_SERVER?: Fetcher;
}

// --- HTML helpers ---

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A protocol event's timestamp, as a 3-line stack (YYMMDD. / HHMMSS. / mmm) that reads top to bottom at decreasing contrast -- compact enough to sit to the left of the line it's on instead of trailing after it, in the same vertical space, with the real ISO string in a title tooltip for whoever needs the exact moment. See the `.ts-stack` CSS below for the actual 1/3-height-per-line layout. */
function timestampStackHtml(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  const date = `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
  const time = `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `<span class="ts-stack" title="${esc(iso)}"><span class="ts-date">${date}.</span><span class="ts-time">${time}.</span><span class="ts-ms">${ms}</span></span>`;
}

// A stable hue per distinct string, not a hand-maintained map -- there
// are 14+ AskKinds and 5 Answer actions already, more whenever a new
// one is added, and a hash keeps every one of them a distinct, same
// color every time it appears without this needing to be revisited.
// Fixed saturation/lightness tuned to stay readable on the dark theme
// this site only ever renders in (no light-mode branch to also tune).
function stringToHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** An AskKind or Answer action, as inline code at its own stable color (see stringToHue) -- the specific verb (`deny`, `whistleblow`, `vote`, ...), not the ASK/ANSWER/INSIGHT envelope type those already have a fixed color for. */
function kindCode(kind: string): string {
  return `<code class="kind-code" style="color:hsl(${stringToHue(kind)},70%,68%)">${esc(kind)}</code>`;
}

/** #62: every Lane's own standalone page -- the origin Lane (id "origin") IS that repo's own page; any other lane_id in the same repo gets its own nested URL, since it has no separate backing repo/slug of its own. */
function laneUrl(repoSlug: string, laneId: string): string {
  return laneId === ORIGIN_LANE_ID ? `/${esc(repoSlug)}` : `/${esc(repoSlug)}/lane/${esc(laneId)}`;
}

/** A Lane id, in its own skewed tag (see .lane-tag) instead of the same plain badge-muted pill every other secondary detail gets -- a Lane is a distinct noun here, not just a label. Links to that Lane's own standalone page (#62) -- repoSlug is required now that every Lane has one, not just an in-page anchor on whichever page happens to be rendering this. */
function laneTagHtml(laneId: string, repoSlug: string): string {
  return `<a href="${laneUrl(repoSlug, laneId)}" class="lane-tag-link"><code class="lane-tag"><span class="text">${esc(laneId)}</span></code></a>`;
}

/**
 * #26: `username` is a literal did:guardian string -- renders it as its
 * "<name>@<domain>" (or bare "@<domain>" for a domain's own root
 * identity) display form, the name component highlighted the same way
 * the old bracket-chained version highlighted the part inside `[...]`.
 * The href stays the literal DID string, never this display form -- per
 * the standing rule that the email-shaped form is for display and mail
 * only, never a lookup key or a URL.
 */
function formatAgentId(username: string): string {
  const parsed = splitGuardianDid(username);
  // One wrapping <a> (not two sibling elements) so a flex row's own
  // `gap` (`.row`) only ever applies around the whole id, not inside it.
  if (!parsed) return `<a href="/${esc(username)}" class="agent-id">${esc(username)}</a>`;
  const display = parsed.name ? `<span class="agent-name">${esc(parsed.name)}</span>@${esc(parsed.domain)}` : `@${esc(parsed.domain)}`;
  return `<a href="/${esc(username)}" class="agent-id">${display}</a>`;
}

/** An Ask id as a link to its own entry in that Lane's own Asks sub-tab -- same mono styling `.mono` uses elsewhere on the page, just without that class's own pill background/padding, which would be visual noise this densely packed inline. */
/** `repoSlug`/`laneId` are needed anywhere this doesn't already sit on that Ask's own Lane page -- a profile's cross-repo Activity feed (agentActivityHtml), unlike a Lane page's own Feed/Asks sub-tabs, since a bare "#ask-id" hash only scrolls within the CURRENT page, it doesn't know which page to go to first. laneId defaults to the origin Lane when omitted -- the common case before #62 (every Ask lived on one repo-wide page); pass it explicitly for an Ask that lives on a non-origin Lane. */
function askIdLink(askId: string, repoSlug?: string, laneId: string = ORIGIN_LANE_ID): string {
  const href = repoSlug ? `${laneUrl(repoSlug, laneId)}#${esc(askId)}` : `#${esc(askId)}`;
  return `<a href="${href}" class="ask-id-link">${esc(askId)}</a>`;
}

// http(s) URL detection, plain and deliberately conservative -- a
// trailing sentence-punctuation character right after a URL (".",
// ",", ")", etc., the common case in a hand-written description: "see
// https://example.com.") is excluded from the match rather than
// swallowed into the link, so the link target doesn't end up with a
// stray period baked in.
const URL_PATTERN = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;

/** Same escaping `esc` does, plus turning any raw http(s) URL in the text into a real, clickable link -- used for repo descriptions specifically (free-text the owner typed, same as a GitHub repo's own "Website" blurb, not markdown), not every `esc` call generally. */
function autolinkText(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(URL_PATTERN)) {
    out += esc(s.slice(last, m.index));
    const url = m[0];
    out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  out += esc(s.slice(last));
  return out;
}

/** An Ask/Answer payload, pretty-printed instead of dumped as one unreadable JSON.stringify() line -- a scrollable box so a large field (e.g. a proposal's full file contents) doesn't blow out the rest of the page's layout. */
// Escapes only what's actually dangerous as HTML TEXT content (&, <,
// >) -- NOT the quote character esc() also escapes, which is only a
// problem inside an HTML attribute value, never here. Left raw, a
// literal `"` still matches the regex below exactly as typed; escaped
// to &quot; first, it wouldn't, and every JSON string most of this
// content actually is would stop being recognized as one.
function escJsonText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// One token at a time: a quoted string (optionally followed by the
// ":" that makes it a key), true/false, null, or a number. Standard
// technique for coloring JSON without a real parser or a client-side
// library -- safe here specifically because escJsonText already ran
// first, so every match is HTML-safe content, never raw user input.
const JSON_TOKEN_RE = /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function syntaxHighlightJson(text: string): string {
  return escJsonText(text).replace(JSON_TOKEN_RE, (match) => {
    let cls = "json-number";
    if (match.startsWith('"')) cls = /:\s*$/.test(match) ? "json-key" : "json-string";
    else if (match === "true" || match === "false") cls = "json-bool";
    else if (match === "null") cls = "json-null";
    return `<span class="${cls}">${match}</span>`;
  });
}

function jsonBlock(value: unknown): string {
  return `<pre class="json-blob">${syntaxHighlightJson(JSON.stringify(value ?? {}, null, 2))}</pre>`;
}

/** Same box jsonBlock renders, for an Insight's own free-text body instead of a payload -- one visual language for "here's the real content of this entry," whether that content is JSON or prose. */
function textBlock(text: string): string {
  return `<pre class="json-blob text-blob">${esc(text)}</pre>`;
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
/** A README's own markdown links are written relative to the repo root (findReadme only ever looks there) -- "LICENSE", "./docs/x.md", "docs/x.md" all need to become a real site path (the repo's own /blob/<ref>/ convention) to go anywhere when clicked, instead of resolving against the CURRENT PAGE's own URL the way a plain relative href normally would. Left untouched: a real absolute URL (any "scheme:"), a protocol-relative "//host/...", and a same-page "#anchor". `href` is already-HTML-escaped text (it comes from renderMarkdown's own pre-escaped `html` string) -- only slug/ref, raw here, need escaping before this gets dropped straight into an href attribute. */
function resolveReadmeLink(href: string, slug: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return href;
  const hashIdx = href.indexOf("#");
  const pathPart = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const hashPart = hashIdx === -1 ? "" : href.slice(hashIdx);
  const normalized = pathPart.replace(/^\.\//, "").replace(/^\/+/, "");
  return `/${esc(slug)}/blob/${esc(ref)}/${normalized}${hashPart}`;
}

function renderMarkdown(src: string, slug: string, ref: string): string {
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
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => `<a href="${resolveReadmeLink(href, slug, ref)}" target="_blank" rel="noopener noreferrer">${text}</a>`)
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

/**
 * #67 follow-up: the README IS the description now -- no separate
 * stored field shown or edited on its own (repos.description/
 * meta.description still exist as the one-time seed doCreateRepo's own
 * README/Ladder-rung generation reads, and what Explore/profile
 * listings show for a short blurb, but there's no dedicated settings
 * UI for it anymore). A real `<!-- more -->` marker (Jekyll/Hugo's own
 * convention) in the raw README source, if present, is the author's
 * own deliberate cut -- everything before it always shows, no fade;
 * everything after sits behind a plain toggle, revealed cleanly on
 * click. With no marker, the WHOLE README is the toggle's own content
 * instead, clipped to a fixed height with a fade at the bottom when
 * collapsed (readme-fold-clip) -- the algorithmic, no-deliberate-
 * boundary case looking visibly different from the deliberate one.
 * Split on the RAW markdown source, before rendering -- renderMarkdown
 * itself has no special handling for an HTML comment (it isn't a real
 * markdown engine), so the marker has to be consumed here, never
 * passed through to it, or it would show up escaped as literal text.
 */
function readmeFoldHtml(raw: string, slug: string, ref: string): string {
  const marker = raw.match(/<!--\s*more\s*-->/i);
  const hasMarker = !!marker;
  const aboveRaw = hasMarker ? raw.slice(0, marker.index) : "";
  const restRaw = hasMarker ? raw.slice(marker.index! + marker[0].length) : raw;
  const aboveHtml = aboveRaw.trim() ? `<div class="md">${renderMarkdown(aboveRaw, slug, ref)}</div>` : "";
  if (!restRaw.trim()) return aboveHtml;
  return `${aboveHtml}
    <div class="readme-fold${hasMarker ? "" : " readme-fold-clip"}" data-readme-fold>
      <div class="md readme-fold-content">${renderMarkdown(restRaw, slug, ref)}</div>
      <button type="button" class="readme-fold-toggle" data-readme-fold-toggle>
        <span class="readme-fold-line"></span><span class="readme-fold-dots">&hellip;</span><span class="readme-fold-line"></span>
      </button>
    </div>`;
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
  /* Same value as --panel (inputs' background) -- a pre/code block
     reads as "a field full of text", not a separately-colored box. */
  --code-bg:#241433;
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
.sub-tabs{background:none;border:none;border-radius:0;padding:0;margin:0}
.card h2{margin:0 0 .6rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.stack>*+*{margin-top:.75rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;line-height:1.5}
.badge{display:inline-flex;align-items:center;padding:.15rem .6rem;border-radius:8px;font-size:.9rem;font-weight:600;border:1px solid;white-space:nowrap}
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
/* The Ladder tab can be arbitrarily deep (one row per file/directory/
   ask/...) -- a fixed height with its own scrollbar keeps the repo
   page itself a bounded height regardless, the same tradeoff the
   Commits tab makes the opposite way (paged, not scrolled) since that
   one's naturally ordered by recency instead of a tree you'd want to
   keep open while scrolling past. */
ul.list.list-scroll{max-height:32rem;overflow-y:auto}
.ladder-filter-bar{display:flex;gap:.5rem;margin-bottom:.6rem}
.ladder-search{flex:1;min-width:0}
.ladder-kind-select{flex-shrink:0;width:auto}
/* .row's own display:flex (same specificity as the browser's default
   [hidden]{display:none} UA rule, but an author style always beats a
   UA style regardless of specificity or source order) was silently
   winning -- zzFilterLadder's li.hidden=true was setting the real
   attribute correctly the whole time, just with zero visible effect.
   Confirmed live. One extra class in the selector is enough to outrank
   .row's own single-class rule within this same author stylesheet. */
li.row[hidden]{display:none}
.repo-item{display:flex;flex-direction:column;gap:.15rem}
.repo-item .name{font-family:var(--mono);color:var(--pink);font-weight:600}
.repo-item .desc{color:var(--muted);font-size:.9rem}
input,select,textarea{font-family:var(--sans);font-size:.95rem;padding:.55rem .7rem;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--fg)}
/* Native select arrows ignore padding-right entirely in Chrome/Safari
   (it's drawn as part of the OS-chrome widget, not CSS content) -- a
   real custom arrow via appearance:none is the only way to control
   its gutter at all. */
select{appearance:none;-webkit-appearance:none;-moz-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23B4A3D6' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .75rem center;background-size:.65em;padding-right:2rem}
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
.hint{color:var(--muted);font-size:.88rem;margin:0 0.5rem 1rem}
.empty{color:var(--muted);font-style:italic;padding:.5rem 0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.6rem}
.card-head h2{margin:0}
.card-head p{margin:0;flex:1;min-width:0}
/* padding-bottom, not padding:0 all round -- line-height:0 alone
   still leaves the glyph sitting visibly below the circle's true
   centerline (confirmed live), and flex centers the content box, so
   a bit of extra bottom padding shifts that box (and the glyph in
   it) up without disturbing the horizontal centering. */
.icon-btn{width:1.8rem;height:1.8rem;padding:0 0 .12rem;border-radius:999px;font-size:1.1rem;line-height:0;display:inline-flex;align-items:center;justify-content:center}
dialog.modal{border:none;border-radius:12px;padding:0;background:var(--surface);color:var(--fg);border:1px solid var(--border);max-width:460px;width:92vw}
dialog.modal::backdrop{background:rgba(10,6,20,.65)}
dialog.modal .modal-body{padding:1.25rem 1.4rem}
dialog.modal h3{margin:0 0 1rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
dialog.modal .modal-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.1rem}
.ac-wrap{position:relative}
.ac-list{position:absolute;top:100%;left:0;min-width:100%;width:max-content;max-width:min(420px,90vw);background:var(--panel);border:1px solid var(--border);border-radius:8px;margin-top:.25rem;max-height:220px;overflow-y:auto;z-index:30}
.ac-item{padding:.5rem .7rem;cursor:pointer;font-size:.88rem}
.ac-item:hover,.ac-item.active{background:var(--surface)}
.tab-bar{display:flex;gap:.25rem;border-bottom:1px solid var(--border);margin-bottom:1rem;flex-wrap:wrap}
.tab-btn{background:none;border:none;color:var(--muted);font-weight:600;padding:.5rem .9rem;border-bottom:2px solid transparent;border-radius:0;cursor:pointer}
.tab-btn.active{color:var(--pink);border-bottom-color:var(--pink)}
.tab-btn:hover{color:var(--fg);background:none}
select.role-select{appearance:none;-webkit-appearance:none;background-color:transparent;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23B4A3D6' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .45rem center;background-size:.6em;border:1px solid var(--border);color:var(--fg);padding:.2rem 1.4rem .2rem .5rem;border-radius:6px;font-size:.85rem}
select.role-select:disabled{opacity:1;color:var(--fg);border-color:transparent;background-color:rgba(180,163,214,.08)}
.split{display:flex;justify-content:space-between;gap:1.5rem;flex-wrap:wrap}
.split>div,.split>details{flex:1 1 16rem;min-width:0}
.readme-fold:not(.readme-fold-clip):not(.is-expanded) .readme-fold-content{display:none}
.readme-fold-clip:not(.is-expanded) .readme-fold-content{max-height:9em;overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,#000 60%,transparent 100%);mask-image:linear-gradient(to bottom,#000 60%,transparent 100%)}
.readme-fold-toggle{display:flex;align-items:center;gap:.6rem;width:100%;background:none;border:none;color:var(--muted);cursor:pointer;padding:.3rem 0;font-size:.85rem;font-family:inherit}
.readme-fold-toggle:hover{color:var(--fg)}
.readme-fold-line{flex:1;height:1px;background:var(--border)}
.readme-fold-dots{flex:none;letter-spacing:.15em}
.align-right{text-align:right}
.align-right pre{text-align:left}
.danger-zone{border-color:rgba(255,68,102,.4)}
h1 .badge{margin-left:.7rem;vertical-align:middle;font-size:.6em}
.clone-row{margin-bottom:.6rem;margin-right:4rem}
.clone-row .pre-wrap{position:relative}
.clone-row pre{margin:0;padding:.33rem 2.3rem .33rem .66rem;overflow-x:auto}
.clone-row .icon-btn{position:absolute;top:50%;right:.35rem;transform:translateY(-50%);width:1.6rem;height:1.6rem;padding:0}
.log-feed{font-family:var(--mono);font-size:.85rem;line-height:1.8}
/* Plain inline flow, not flex -- a flex container treats every loose
   text run between its inline children (a badge, a space, a link, ...)
   as its own anonymous flex item, and collapses/repositions the
   whitespace at each one's edges instead of just leaving it exactly as
   written the way normal inline text does. .ts-stack's own
   vertical-align keeps it lined up with the text beside it without
   needing the parent to be a flex container to get there. */
.log-line{white-space:nowrap;overflow-x:auto}
.log-line .t-ask{color:var(--yellow);font-weight:600}
.log-line .t-answer{color:var(--green);font-weight:600}
.log-line .t-insight{color:var(--cyan);font-weight:600}
/* A timestamp as a 3-line stack (date/time/ms) instead of one trailing
   string -- compact enough to sit leftmost, in the same vertical space
   as the single line of text beside it. Each line is font-size .45em
   at line-height 1, so all three together (1.35em) land close to a
   normal line's own height; opacity steps down date->time->ms since
   the date rarely matters once you're reading a live-ish feed, same
   reasoning the 0.5 skill's "reduce to what's actually load-bearing"
   applies to any repeated element. The real ISO instant is the title
   tooltip, for whenever the exact moment is what's actually needed. */
.ts-stack{display:inline-flex;flex-direction:column;justify-content:center;vertical-align:middle;margin-right:1.5em;font-family:var(--mono);font-size:.45em;line-height:.8;cursor:help}
.ts-stack span{display:block}
.ts-stack .ts-date{opacity:.85}
.ts-stack .ts-time{opacity:.55}
.ts-stack .ts-ms{opacity:.3}
.kind-code{font-family:var(--mono);background:rgba(255,255,255,.06);padding:.05rem .35rem;border-radius:0;border:1px solid darkslategrey;font-size:.8em}
.agent-id{color:var(--muted);text-decoration:none}
.agent-id:hover{text-decoration:underline}
.agent-name{color:steelblue}
.ask-id-link{font-family:var(--mono);font-size:.92em;color:var(--cyan);text-decoration:none;border-bottom:1px dotted currentColor}
.ask-id-link:hover{text-decoration:none;border-bottom-style:solid}
.ask-answer-row{margin:.6rem 0 0 1.25rem;padding-left:.6rem;border-left:2px solid rgba(255,255,255,.12)}
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
.blob-header .summary-detail{flex:1 0 100%;margin-top:.4rem}
.download-btn{margin-left:auto;font-size:.85rem;font-weight:700;padding:.35rem .8rem;border-radius:8px;border:1px solid var(--pink);background:var(--pink);color:#1A0F2E !important}
.download-btn:hover{background:#ff58a8;text-decoration:none}
.blob-body{border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;overflow:hidden}
.blob-body pre{margin:0;border:none;border-radius:0}
.diff-body{font-family:var(--mono);font-size:.85rem;background:#1A0F2E;padding:.5rem 0;overflow-x:auto;white-space:pre}
.diff-body>div{padding:0 1rem}
.diff-marker{display:inline-block;width:1.2em;color:var(--muted);user-select:none}
.diff-add{background:rgba(76,255,110,.12)}
.diff-add .diff-marker{color:var(--green)}
.diff-del{background:rgba(255,68,102,.12)}
.diff-del .diff-marker{color:var(--red)}
.commit-nav{display:flex;justify-content:space-between;gap:1rem;margin-top:1rem}
.json-blob{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;margin:.4rem 0 0;max-height:260px;overflow:auto;font-family:var(--mono);font-size:.82rem;white-space:pre}
.text-blob{white-space:pre-wrap;word-break:break-word}
.json-key{color:var(--cyan)}
.json-string{color:var(--green)}
.json-number{color:var(--yellow)}
.json-bool{color:var(--pink)}
.json-null{color:var(--muted);font-style:italic}
/* A Lane is a real, distinct noun in this system, not just another
   label -- skewed forward like it's already in motion, the way a
   workstream actually is, instead of sitting in the same plain
   badge-muted pill every other secondary detail gets. The inner .text
   counter-skews back upright so the id itself stays readable; the
   outer element's own tag doesn't matter (a <code>, a <span>, same
   transform either way), only that it's display:inline-block, which
   this sets explicitly regardless of the tag's own default. */
.lane-tag-link{text-decoration:none}
.lane-tag{display:inline-block;vertical-align:middle;background:rgba(92,141,255,.15);border:1px solid rgba(92,141,255,.4);border-radius:4px;padding:0 .6em;margin:0 .2em;font-family:var(--mono);font-size:.85em;color:var(--blue);transform:skewX(-15deg)}
.lane-tag-link:hover .lane-tag{background:rgba(92,141,255,.28)}
/* A Ladder rung's own kind (file/changeset/filechange/...) -- its own
   distinct six-sided shape (clip-path slices both side edges to a
   point) instead of the rounded .badge pill every other kind label
   gets, since a rung is a structural object in this system, not just
   a label. Surface/border/fg instead of the stone/zinc literal colors
   this was adapted from, to match the rest of the theme. */
.rung{display:inline-block;vertical-align:middle;background:#342e56;color:#e2589a;font-family:var(--mono);font-weight:600;font-size:.85rem;padding:.15em 1em;margin:0 .2em;border-top:1px solid #121827;border-bottom:1px solid #121827;clip-path:polygon(6px 0%,calc(100% - 6px) 0%,100% 50%,calc(100% - 6px) 100%,6px 100%,0% 50%)}
/* A Role (owner/coordinator/contributor/viewer), framed by subtle
   corner crosshairs instead of a solid pill border -- the role name's
   own color (its existing badge-variant semantics) carries the
   meaning; the crosshairs just mark it as a distinct kind of token. */
.scope{display:inline-block;vertical-align:middle;position:relative;font-family:var(--mono);font-size:.82rem;padding:0em .5em;margin:0 .2em;border-radius:4px}
.scope::before,.scope::after{content:"";position:absolute;width:4px;height:6px;border-color:var(--muted);border-style:solid}
.scope::before{top:0;left:0;border-width:1px 0 0 1px}
.scope::after{bottom:0;right:0;border-width:0 1px 1px 0}
.lane-tag .text{display:inline-block;transform:skewX(15deg)}
.summary-detail{margin-top:.5rem;font-size:.82rem}
.summary-detail summary{cursor:pointer;color:var(--muted);user-select:none}
.summary-detail ul,.summary-detail p{margin-top:.5rem}
.shard-group{margin-top:.4rem;font-size:.85rem}
.shard-group summary{cursor:pointer;color:var(--muted);user-select:none}
.shard-group ul.list{margin-top:.4rem;padding-left:1.1rem;border-left:2px solid var(--border)}
`;

function card(heading: string, innerHtml: string, opts: { addModal?: string; extraClass?: string } = {}): string {
  const addBtn = opts.addModal ? `<button type="button" class="icon-btn" onclick="document.getElementById('${opts.addModal}').showModal()" aria-label="Add" title="Add">+</button>` : "";
  return `<section class="card${opts.extraClass ? ` ${opts.extraClass}` : ""}"><div class="card-head"><h2>${esc(heading)}</h2>${addBtn}</div>${innerHtml}</section>`;
}

const ROLE_BADGE_VARIANT: Record<string, string> = { owner: "pink", coordinator: "blue", contributor: "green", viewer: "muted" };
const LANE_STATUS_BADGE_VARIANT: Record<string, string> = { proposed: "yellow", open: "yellow", claimed: "blue", active: "cyan", merged: "green", closed: "muted", vetoed: "red", stopped: "red" };
const BADGE_VARIANT_COLOR: Record<string, string> = { pink: "var(--pink)", yellow: "var(--yellow)", cyan: "var(--cyan)", green: "var(--green)", blue: "var(--blue)", red: "var(--red)", muted: "var(--muted)" };
/** A Lane's status, as .kind-code (the same box every other protocol-event kind/action gets), colored by its existing badge-variant semantics instead of a hash -- vetoed/stopped stay red, merged stays green, etc. */
function laneStatusCode(status: string): string {
  const color = BADGE_VARIANT_COLOR[LANE_STATUS_BADGE_VARIANT[status] ?? "muted"];
  return `<code class="kind-code" style="color:${color}">${esc(status)}</code>`;
}
/** `agentLinkHtml`: the formatAgentId-formatted link of whoever holds this role, when there's a specific agent to name (a repo's own Roles list) -- rendered INSIDE the .scope span, right before the role name, not as a sibling element. Omitted where a role is shown with no separate agent to link (a profile's own Repos list: "this repo, your role X" has no second party to name). */
function roleBadge(role: string, agentLinkHtml?: string): string {
  const color = BADGE_VARIANT_COLOR[ROLE_BADGE_VARIANT[role] ?? "muted"];
  const prefix = agentLinkHtml ? `${agentLinkHtml} ` : "";
  return `<span class="scope" style="color:${color}">${prefix}${esc(role)}</span>`;
}

// Loosest to strictest, same order engine/policy.ts's own
// MODE_STRICTNESS uses -- green means "just commit", red means "needs
// a real Vote," the two ask-gated modes in between get the same
// yellow a changeset_review itself gets elsewhere on this page.
const POLICY_MODE_VARIANT: Record<string, string> = { direct: "green", self_review: "yellow", other_approver: "yellow", vote_quorum: "red", vote_expiring: "cyan" };
function policyModeCode(rule: { mode: string; expiry_hours?: number }): string {
  const color = BADGE_VARIANT_COLOR[POLICY_MODE_VARIANT[rule.mode] ?? "muted"];
  const expiry = rule.mode === "vote_expiring" ? ` <span class="muted">(expires ${esc(String(rule.expiry_hours ?? 72))}h)</span>` : "";
  return `<code class="kind-code" style="color:${color}">${esc(rule.mode)}</code>${expiry}`;
}

/** The repo page's own "Policy" panel -- same collapsed-by-default <details> the Roles panel uses, since Policy is meant to be visible to a repo's Coordinators, not just enforced against them. */
function policyPanelHtml(policy: RepoPolicy): string {
  const repoRow = `<li class="row"><span class="rung">policy_change</span> ${policyModeCode(policy.policy_change)}</li>`;
  const pathRows = policy.policies.map((r) => `<li class="row"><span class="rung">${esc(r.path)}</span> ${policyModeCode(r)}</li>`).join("");
  const claimRow = `<li class="row"><span class="rung">claim_mode</span> <span class="scope">manual: ${esc(policy.claim_mode.manual)}</span> <span class="scope">autonomous: ${esc(policy.claim_mode.autonomous)}</span></li>`;
  const retentionRow = `<li class="row"><span class="rung">retention</span> <span class="scope">${esc(policy.retention.mode)}</span></li>`;
  const conflictRows = policy.conflict_policies.map((r) => `<li class="row"><span class="rung">conflict: ${esc(r.path)}</span> ${policyModeCode(r)}</li>`).join("");
  return `<details class="summary-detail"><summary>Policy</summary><ul class="list">${repoRow}${pathRows}${claimRow}${retentionRow}${conflictRows}</ul></details>`;
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
// Reads the CURRENT location.hash and activates/scrolls to whatever it
// names in this one container -- split out from wiring up the click
// handlers (zzInitTabs, below) because a same-page anchor click (an
// ask-id link, e.g.) only ever changes location.hash, it doesn't
// reload the page, so this needs to be callable again on its own, on
// 'hashchange', not just once at load.
//
// #62: a Lane page nests a tab group (Feed/Lanes/Asks, etc.) inside
// each top-level tab's own panel (Activity/Context/Code) -- a plain
// container.querySelectorAll('.tab-btn'/'.tab-panel') isn't scoped to
// DIRECT children, so the outer container's own init/hash handling
// used to also pick up every inner group's buttons and panels,
// confirmed live: clicking an inner sub-tab also fired the outer
// container's click handler (same button, two listeners), which hid
// every panel under the outer container -- including the inner
// group's own container panel itself -- blanking the whole page.
// zzOwnTabBtns/zzOwnTabPanels fix this by keeping only the elements
// whose NEAREST [data-tabs] ancestor is this exact container, not some
// nested one.
function zzOwnTabBtns(container) {
  return Array.prototype.filter.call(container.querySelectorAll('.tab-btn'), function (b) { return b.closest('[data-tabs]') === container; });
}
function zzOwnTabPanels(container) {
  return Array.prototype.filter.call(container.querySelectorAll('.tab-panel'), function (p) { return p.closest('[data-tabs]') === container; });
}
function zzApplyHash(container) {
  var btns = zzOwnTabBtns(container);
  var hash = location.hash.slice(1);
  // A hash naming a specific element inside one of this container's
  // panels (an Ask's own id="ask-..." anchor, e.g.) needs THAT
  // element's panel activated, not just a literal tab-id match below --
  // an ask-id link always points at one, since that's the only way to
  // reach a hidden tab's content at all.
  var targetEl = hash ? document.getElementById(hash) : null;
  var targetPanel = targetEl ? targetEl.closest('.tab-panel') : null;
  btns.forEach(function (btn) {
    // dataset.target is "<groupId>-<tabId>" -- match on the tabId
    // suffix so a reload from a Commits pager link (or any other
    // cross-tab link ending in #<tabId>) reopens on that tab instead
    // of always landing back on whichever one renders first.
    if (hash && btn.dataset.target.endsWith('-' + hash)) {
      btn.click();
    } else if (targetPanel && btn.dataset.target === targetPanel.id) {
      btn.click();
    }
  });
  if (targetEl) targetEl.scrollIntoView({ block: 'center' });
}
function zzInitTabs(container) {
  var btns = zzOwnTabBtns(container);
  btns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      btns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      zzOwnTabPanels(container).forEach(function (p) { p.hidden = true; });
      document.getElementById(btn.dataset.target).hidden = false;
    });
  });
  zzApplyHash(container);
}
var zzTabContainers = document.querySelectorAll('[data-tabs]');
zzTabContainers.forEach(zzInitTabs);
window.addEventListener('hashchange', function () {
  zzTabContainers.forEach(zzApplyHash);
});

// A plain client-side filter over the Ladder tab's own already-rendered
// rows (each one's data-search/data-kind attributes, set by
// renderLadderNode) -- no second request, no server round trip. A row
// shows only when it matches BOTH the typed text (data-search contains
// it, case-insensitive; empty box matches everything) AND the kind
// select (exact match; "all kinds" matches everything).
function zzFilterLadder(bar) {
  var q = bar.querySelector('[data-ladder-search]').value.trim().toLowerCase();
  var kind = bar.querySelector('[data-ladder-kind-filter]').value;
  var list = bar.nextElementSibling;
  if (!list) return;
  list.querySelectorAll('li[data-search]').forEach(function (li) {
    var matchesText = q.length === 0 || li.dataset.search.indexOf(q) !== -1;
    var matchesKind = !kind || li.dataset.kind === kind;
    li.hidden = !(matchesText && matchesKind);
  });
}

// Shared by every ac-list dropdown (agent autocomplete, Explore
// search): Up/Down moves a highlighted ".active" item among whatever
// ".ac-item" rows are currently in listEl, Enter clicks it (reusing
// each caller's own onclick, not a second selection path), Escape
// closes it. Reads listEl.children live rather than tracking a
// separate items array, so it stays correct no matter how/when a
// caller repopulates the list.
function zzListNav(inputEl, listEl) {
  var activeIndex = -1;
  function items() { return Array.prototype.slice.call(listEl.querySelectorAll('.ac-item')); }
  function setActive(i) {
    var els = items();
    els.forEach(function (el) { el.classList.remove('active'); });
    if (els.length === 0) { activeIndex = -1; return; }
    activeIndex = (i + els.length) % els.length;
    els[activeIndex].classList.add('active');
    els[activeIndex].scrollIntoView({ block: 'nearest' });
  }
  inputEl.addEventListener('keydown', function (e) {
    if (listEl.hidden) return;
    var els = items();
    if (els.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') { if (activeIndex >= 0) { e.preventDefault(); els[activeIndex].click(); } }
    else if (e.key === 'Escape') { listEl.hidden = true; }
  });
  inputEl.addEventListener('input', function () { activeIndex = -1; });
}

function zzAutocomplete(inputEl, listEl, url) {
  var t;
  zzListNav(inputEl, listEl);
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
  zzListNav(inputEl, listEl);
  function addItem(variant, label, href) {
    var item = document.createElement('div');
    item.className = 'ac-item';
    var badge = document.createElement('span');
    badge.className = 'badge badge-' + variant;
    badge.style.marginRight = '.5rem';
    badge.textContent = variant === 'pink' ? 'lane' : variant === 'cyan' ? 'user' : 'ladder';
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
      fetch('/api/explore/search?q=' + encodeURIComponent(q)).then(function (r) { return r.ok ? r.json() : { lanes: [], agents: [], ladderHits: [] }; }).then(function (data) {
        listEl.innerHTML = '';
        (data.lanes || []).forEach(function (l) { addItem('pink', l.name, '/' + l.repo_slug + '#lane-' + l.lane_id); });
        (data.agents || []).forEach(function (a) { addItem('cyan', a.username, '/' + a.username); });
        (data.ladderHits || []).forEach(function (h) { addItem('yellow', h.repo_slug + ': ' + h.summary.slice(0, 60), '/' + h.repo_slug + '/blob/' + (h.commit_sha || 'HEAD') + '/' + h.path); });
        listEl.hidden = (data.lanes || []).length === 0 && (data.agents || []).length === 0 && (data.ladderHits || []).length === 0;
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

// Creating a real Lane (a real git repo, initial commit, Ladder, and
// origin Lane, not a quick DB row) genuinely takes a few real seconds
// -- a plain form POST gave no feedback for that whole wait beyond the
// browser's own tab spinner, which looked indistinguishable from
// having frozen (confirmed as a real reported UX complaint). Posts to
// the same JSON API the CLI already uses (/api/repos, same-origin
// session cookie works here the same way it works for every other
// fetch call on this page) instead of a page-reloading form, so the
// dialog can show a real, persistent "creating" state for the whole
// wait, then navigate once it actually succeeds.
var createRepoForm = document.getElementById('create-repo-form');
if (createRepoForm) {
  createRepoForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = createRepoForm.querySelector('button[type="submit"]');
    var cancelBtn = createRepoForm.querySelector('button[type="button"]');
    var progressEl = createRepoForm.querySelector('[data-create-repo-progress]');
    var errEl = createRepoForm.querySelector('[data-create-repo-error]');
    var data = new FormData(createRepoForm);
    btn.disabled = true;
    cancelBtn.disabled = true;
    btn.textContent = 'Creating...';
    progressEl.hidden = false;
    errEl.hidden = true;
    fetch('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: data.get('name'), description: data.get('description') || undefined, license: data.get('license') || undefined }),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok) {
          window.location.href = '/' + result.body.slug;
          return;
        }
        btn.disabled = false;
        cancelBtn.disabled = false;
        btn.textContent = 'Create';
        progressEl.hidden = true;
        errEl.textContent = result.body.error || 'Something went wrong -- try again.';
        errEl.hidden = false;
      })
      .catch(function () {
        btn.disabled = false;
        cancelBtn.disabled = false;
        btn.textContent = 'Create';
        progressEl.hidden = true;
        errEl.textContent = "Couldn't reach the server -- try again.";
        errEl.hidden = false;
      });
  });
}

// #62: the Lane page's own inline "post an ask" form (Asks sub-tab) --
// posts to the same JSON API the CLI already uses (/api/repos/:slug/ask),
// same-origin session cookie works here the same way it works for the
// create-Lane form above. Reloads the page on success rather than
// patching just the Asks panel in place -- this Lane page has no live-
// polling layer yet (a separate, later piece), so a full reload is the
// correct way to show the newly posted ask right now.
var postAskForm = document.querySelector('[data-post-ask-form]');
if (postAskForm) {
  postAskForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = postAskForm.querySelector('input[name="description"]');
    var btn = postAskForm.querySelector('button[type="submit"]');
    var repoSlug = postAskForm.dataset.postAskRepo;
    var laneId = postAskForm.dataset.postAskLane;
    var description = input.value.trim();
    if (!description) return;
    btn.disabled = true;
    input.disabled = true;
    fetch('/api/repos/' + repoSlug + '/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: description, lane_id: laneId }),
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok) {
          window.location.reload();
          return;
        }
        btn.disabled = false;
        input.disabled = false;
        alert(result.body.error || 'Something went wrong -- try again.');
      })
      .catch(function () {
        btn.disabled = false;
        input.disabled = false;
        alert("Couldn't reach the server -- try again.");
      });
  });
}

// #62 follow-up: real-time polling for a Lane page's own live panels
// (Feed/Lanes/Asks/Graph/Insights/Commits) -- each [data-live-panel]
// element names its own repo/lane (and, for Commits, page) via data
// attributes, polls its own small fragment endpoint on an interval,
// and replaces its innerHTML wholesale with whatever comes back
// (plain HTML text, not JSON -- the server already rendered it, this
// never re-renders anything client-side). Paused while the browser
// tab itself isn't visible, not paused just because its own tab
// panel is currently hidden -- switching back to a sub-tab that's
// been polling in the background should never show stale content.
var zzLivePollMs = 3000;
document.querySelectorAll('[data-live-panel]').forEach(function (el) {
  var panel = el.dataset.livePanel;
  var repoSlug = el.dataset.liveRepo;
  var laneId = el.dataset.liveLane;
  var page = el.dataset.livePage;
  var base = (laneId === 'origin' ? '/' + repoSlug : '/' + repoSlug + '/lane/' + laneId) + '/fragment/' + panel;
  var url = page ? base + '?page=' + page : base;
  var inFlight = false;
  function poll() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    fetch(url)
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        inFlight = false;
        if (text === null) return;
        el.innerHTML = text;
        // The Graph panel's filter bar (zzFilterLadder) is the
        // live-panel's own previous sibling, outside the swapped
        // innerHTML -- so the input/select keep whatever the viewer
        // typed, but the li.hidden state the LAST filter run set is
        // gone (every row was just replaced with fresh, unfiltered
        // markup). Re-run it against the freshly-fetched rows so a
        // live update doesn't silently undo an active filter while
        // leaving its own input looking like it's still applied.
        var filterBar = el.previousElementSibling;
        if (filterBar && filterBar.hasAttribute('data-ladder-filter-bar')) zzFilterLadder(filterBar);
      })
      .catch(function () { inFlight = false; });
  }
  setInterval(poll, zzLivePollMs);
});

// README fold (readmeFoldHtml) -- a plain toggle, not <details>: the
// clipped-but-visible "fade" preview (readme-fold-clip, the no-marker
// case) needs its content to stay in the DOM and visible even while
// collapsed, which <details> can't do (its own UA stylesheet fully
// hides non-summary children until [open]).
document.querySelectorAll('[data-readme-fold-toggle]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    btn.closest('[data-readme-fold]').classList.toggle('is-expanded');
  });
});
`;

function layout(title: string, agent: Agent | null, body: string, opts: { cookies?: string[]; titleHtml?: string; h1Html?: string; centerTitle?: boolean } = {}): Response {
  // Same items, same order, as the docs site's own nav (site/themes/zz-docs/fragments/header.html) --
  // Explore/Work/Docs/Source always present, then whatever's auth-dependent.
  const navHead = `<a href="/explore">Explore</a><a href="/work">Work</a><a href="/docs/">Docs</a><a href="https://github.com/zzmq-dev/zz">Source</a>`;
  const nav = agent ? `${navHead}${formatAgentId(agent.username)}<a href="/logout">Log out</a>` : `${navHead}<a href="/login">Log in</a>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - zz</title>
<style>${WEB_CSS}</style></head><body>
<header class="topbar"><a href="/" class="brand">zz<span>_</span></a><nav class="links">${nav}</nav></header>
<main>
<h1${opts.centerTitle ? ' style="text-align:center"' : ""}>${opts.h1Html ?? esc(title)}${opts.titleHtml ?? ""}</h1>
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

async function handleLogin(request: Request, env: WebEnv): Promise<Response> {
  const cliNonce = new URL(request.url).searchParams.get("cli_nonce") ?? "";
  // Only when there's no cli_nonce -- the CLI's own login bridge needs
  // a real OAuth round trip to mint a fresh token for itself even from
  // an already-logged-in browser, so that flow always shows the
  // buttons. Without one, this is just "click login from the main
  // page" (or a stale bookmark/back-button), and a valid session
  // already answers that -- showing the buttons again instead of just
  // taking you into the app was the actual complaint.
  if (!cliNonce) {
    const me = await resolveRequestAgent(request, env);
    if (me) return redirect(`/${me.username}`);
  }
  const qs = cliNonce ? `?cli_nonce=${encodeURIComponent(cliNonce)}` : "";
  const err = new URL(request.url).searchParams.get("err");
  return layout(
    "Log in",
    null,
    `${cliNonce ? '<p class="hint">Logging in for the zz CLI -- this browser tab can be closed once it redirects back.</p>' : ""}
     ${err ? `<p class="hint" style="color:var(--pico-del-color,#c33)">${esc(err)}</p>` : ""}
     <div class="card stack" style="max-width:320px;margin:0 auto">
       <a href="/auth/start/cloudflare${qs}" style="display:block"><button style="width:100%;padding:.85rem 1.1rem">Log in with Cloudflare</button></a>
       <a href="/auth/start/google${qs}" style="display:block"><button class="secondary" style="width:100%;padding:.85rem 1.1rem">Log in with Google</button></a>
       <a href="/auth/start/github${qs}" style="display:block"><button class="secondary" style="width:100%;padding:.85rem 1.1rem">Log in with GitHub</button></a>
     </div>
     <div class="card stack" style="max-width:320px;margin:1rem auto 0">
       <form method="post" action="/auth/guardian/start${qs}" class="stack">
         <label for="guardian-id">Sign in with your Guardian ID</label>
         <input id="guardian-id" name="identifier" placeholder="alice, or alice@acme.com" required>
         <button class="secondary" style="width:100%;padding:.85rem 1.1rem" type="submit">Sign in</button>
       </form>
     </div>`,
    { centerTitle: true },
  );
}

async function handleAuthStart(provider: Provider, request: Request, env: WebEnv): Promise<Response> {
  const cliNonce = new URL(request.url).searchParams.get("cli_nonce") ?? "";
  const state = shortId("state");
  const url = buildAuthorizeUrl(provider, env, state);
  const cookies = [`zz_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`];
  if (cliNonce) cookies.push(`zz_cli_nonce=${cliNonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  // Linking mode: an already-authenticated agent connecting another
  // provider from its own profile, not logging in -- carries the
  // current session's own agent through the OAuth round trip the same
  // way cli_nonce does, so the callback knows to bind instead of
  // running its normal login/create logic.
  if (new URL(request.url).searchParams.get("link") === "true") {
    const me = await resolveRequestAgent(request, env);
    if (me) cookies.push(`zz_link_agent=${encodeURIComponent(me.username)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  }
  return redirect(url, { cookies });
}

/**
 * The shared tail end of every interactive login (the three OAuth
 * providers, did:guardian, and the name-picker's own success path):
 * create a session, fulfill a waiting CLI bridge if there is one, mint
 * a first bearer token on a brand-new agent's first-ever browser login
 * (shown once -- see the original inline version's own reasoning,
 * preserved here verbatim), otherwise just land on the profile.
 * `extraCardsHtml` lets a caller (the name-picker) prepend its own
 * shown-once secret before this renders.
 */
async function finishInteractiveLogin(env: WebEnv, agent: Agent, cliNonce: string | undefined, extraCardsHtml = ""): Promise<Response> {
  const session = await createSession(env.DB, agent.username, 60 * 60 * 24 * 30);

  if (cliNonce) {
    const plaintext = generateAgentToken();
    await createAgentToken(env.DB, agent.username, hashAgentToken(plaintext));
    const fulfilled = await fulfillCliLoginSession(env.DB, cliNonce, agent.username, plaintext);
    if (fulfilled) {
      return layout(
        "Logged in",
        agent,
        `${extraCardsHtml}<div class="card"><p>Logged in as ${formatAgentId(agent.username)}. You can close this tab and return to your terminal.</p></div>`,
      );
    }
  }

  const existingTokens = (await listTokensForAgent(env.DB, agent.username)).filter((t) => !t.revoked_at);
  if (existingTokens.length === 0) {
    const plaintext = generateAgentToken();
    await createAgentToken(env.DB, agent.username, hashAgentToken(plaintext));
    return layout(
      "Welcome",
      agent,
      `${extraCardsHtml}<div class="card stack">
         <p>Logged in as ${formatAgentId(agent.username)}. Here's a token for <code>git push</code>, the CLI, or any script acting as you -- copy it now, it won't be shown again:</p>
         <div class="clone-row"><pre>${esc(plaintext)}</pre><button class="secondary icon-btn" data-copy="${esc(plaintext)}" title="Copy">⧉</button></div>
         <p><a href="/${esc(agent.username)}">Continue to your profile &rarr;</a></p>
       </div>`,
      { cookies: [sessionCookieHeader(session.id, 60 * 60 * 24 * 30)] },
    );
  }

  if (extraCardsHtml) {
    return layout("Welcome back", agent, `${extraCardsHtml}<p><a href="/${esc(agent.username)}">Continue to your profile &rarr;</a></p>`, {
      cookies: [sessionCookieHeader(session.id, 60 * 60 * 24 * 30)],
    });
  }
  return redirect(`/${agent.username}`, { cookies: [sessionCookieHeader(session.id, 60 * 60 * 24 * 30)] });
}

interface PendingLink {
  provider: Provider;
  subject: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: string | null;
  displayName: string;
  email: string | null;
}

const PENDING_LINK_COOKIE = "zz_pending_link";

/**
 * Plain btoa() on a JSON string throws outright the moment it contains any
 * character outside Latin1 -- confirmed live: a real OAuth provider's own
 * displayName/email can contain anything (accented letters, non-Latin
 * scripts, emoji), so this isn't a hypothetical edge case. UTF-8 encode
 * first, base64 the resulting bytes -- the standard fix, same shape
 * auth.ts's own encryptSecret/decryptSecret already use for ciphertext.
 */
function toBase64Unicode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function fromBase64Unicode(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function pendingLinkCookie(link: PendingLink): string {
  return `${PENDING_LINK_COOKIE}=${toBase64Unicode(JSON.stringify(link))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

function readPendingLink(request: Request): PendingLink | null {
  const raw = (request.headers.get("cookie") ?? "").match(new RegExp(`${PENDING_LINK_COOKIE}=([^;]+)`))?.[1];
  if (!raw) return null;
  try {
    return JSON.parse(fromBase64Unicode(raw)) as PendingLink;
  } catch {
    return null;
  }
}

const CLEAR_PENDING_LINK_COOKIE = `${PENDING_LINK_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/** Binds an OAuth identity to an already-resolved agent -- the shared operation behind both halves of account linking (2.3): proving an existing did:guardian id from the "account not found" interstitial, and connecting a provider from an already-authenticated profile settings page. */
async function bindProviderIdentity(env: WebEnv, agent: Agent, link: PendingLink): Promise<void> {
  await createAgentIdentity(env.DB, agent.username, link.provider, link.subject, {
    accessTokenEnc: link.accessTokenEnc,
    refreshTokenEnc: link.refreshTokenEnc,
    expiresAt: link.expiresAt,
  });
}

/** A did:guardian identifier's own name/domain, parsed locally just for a reasonable fallback display name on a lazily-created agent -- not the authoritative parse (that's the registrar's own job); good enough for "alice" out of "did:guardian:alice:acme.com", or the bare domain itself for a root identity. */
function splitGuardianDid(did: string): { name: string | null; domain: string } | null {
  const parts = did.split(":");
  if (parts[0] !== "did" || parts[1] !== "guardian" || parts.length < 3) return null;
  const rest = parts.slice(2);
  return rest.length === 1 ? { name: null, domain: rest[0] } : { name: rest[0], domain: rest[1] };
}

/**
 * The inverse of formatAgentId's own display rendering -- resolves
 * either shape a URL path segment identifying an agent might actually
 * be in: already the literal did:guardian:... string (every link
 * built before this existed, and every one still built that way,
 * unaffected), or the "name@domain"/"@domain" display form (what new
 * repo slugs now embed as their own owner segment, see
 * ownerUrlSegment). Returns the raw input unchanged if it's neither --
 * getAgent's own lookup then just fails naturally, same 404 as today.
 */
function identifierToDid(raw: string): string {
  if (raw.startsWith("did:guardian:")) return raw;
  const parsed = parseGuardianIdentifier(raw);
  if (!parsed) return raw;
  return parsed.name ? `did:guardian:${parsed.name}:${parsed.domain}` : `did:guardian:${parsed.domain}`;
}

/** Finds the local agent for a did:guardian identity, or -- for one zz has never seen before (always a foreign, non-zzmq.dev identity in practice, since every zzmq.dev identity is created through /onboard/guardian-name, which always creates its own local row first) -- lazily creates a minimal one. Reuses all of zz's existing agents-table machinery (tokens, Role grants, attribution) unchanged; no separate identity model for a foreign id. */
async function resolveOrCreateAgentForDid(env: WebEnv, guardianDid: string): Promise<Agent> {
  const existing = await getAgent(env.DB, guardianDid);
  if (existing) return existing;
  const parsed = splitGuardianDid(guardianDid);
  const displayName = parsed?.name ?? parsed?.domain ?? guardianDid;
  return createAgent(env.DB, guardianDid, displayName, null, null);
}

/** The shared "didn't resolve" landing page for both a providerless OAuth login (no existing binding) and a did:guardian sign-in attempt that never got as far as an authenticated DID (bad identifier, no credential, unreachable registrar) -- one continuous workflow into creating a new id or trying again, not a separate front-door choice. `pendingLinkSet` is true when there's a real OAuth identity waiting to be bound, which adds the "I already have an id" option. */
function notFoundInterstitial(reason: string, cliNonce: string | undefined, pendingLinkSet: boolean, cookies: string[] = []): Response {
  const qs = cliNonce ? `?cli_nonce=${encodeURIComponent(cliNonce)}` : "";
  return layout(
    "Account not found",
    null,
    `<div class="card stack" style="max-width:420px;margin:0 auto">
       <p>${esc(reason)}</p>
       <a href="/onboard/guardian-name${qs}" style="display:block"><button style="width:100%;padding:.85rem 1.1rem">Create a new zzmq.dev id</button></a>
       ${pendingLinkSet ? `<a href="/login${qs}#guardian-id" style="display:block"><button class="secondary" style="width:100%;padding:.85rem 1.1rem">I already have an id -- sign in to link it</button></a>` : ""}
       <a href="/login${qs}" style="display:block"><button class="secondary" style="width:100%;padding:.85rem 1.1rem">Go back and try again</button></a>
     </div>`,
    { centerTitle: true, cookies },
  );
}

async function handleAuthCallback(provider: Provider, request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieState = cookieHeader.match(/zz_oauth_state=([^;]+)/)?.[1];
  const cliNonce = cookieHeader.match(/zz_cli_nonce=([^;]+)/)?.[1];
  const linkAgentUsername = cookieHeader.match(/zz_link_agent=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) {
    return new Response("OAuth state mismatch or missing code -- please try logging in again.", { status: 400 });
  }

  const identity = await exchangeCodeForIdentity(provider, env, code);
  const existing = await findAgentIdentity(env.DB, provider, identity.subject);
  const expiresAt = identity.expiresInSeconds ? new Date(Date.now() + identity.expiresInSeconds * 1000).toISOString() : null;
  const accessTokenEnc = await encryptSecret(env, identity.accessToken);
  const refreshTokenEnc = identity.refreshToken ? await encryptSecret(env, identity.refreshToken) : null;

  // Linking mode (from profile settings' own "connect another login"):
  // never a login, always a bind onto the agent that started this OAuth
  // round trip -- not whatever findAgentIdentity/getAgentByEmail would
  // otherwise resolve to.
  if (linkAgentUsername) {
    const linkAgent = await getAgent(env.DB, decodeURIComponent(linkAgentUsername));
    if (!linkAgent) return new Response("Your session expired before this connected -- please try again.", { status: 400 });
    if (existing && existing.agent_username !== linkAgent.username) {
      return new Response(`This ${provider} login is already connected to a different zzmq.dev id.`, { status: 409 });
    }
    if (existing) {
      await updateIdentityTokens(env.DB, existing.id, { accessTokenEnc, refreshTokenEnc, expiresAt });
    } else {
      await createAgentIdentity(env.DB, linkAgent.username, provider, identity.subject, { accessTokenEnc, refreshTokenEnc, expiresAt });
    }
    return withExtraCookie(redirect(`/${linkAgent.username}`), `zz_link_agent=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  }

  if (existing) {
    const agent = (await getAgent(env.DB, existing.agent_username))!;
    await updateIdentityTokens(env.DB, existing.id, { accessTokenEnc, refreshTokenEnc, expiresAt });
    await refreshAgentProfile(env.DB, agent.username, identity.displayName, identity.email);
    return finishInteractiveLogin(env, agent, cliNonce);
  }

  // No known binding for this (provider, subject) yet. A matching email
  // on file is a *hint*, never sufficient to bind by itself -- a real
  // bug this used to have (confirmed live, not hypothetical): it auto-
  // linked a second OAuth provider onto whichever agent happened to own
  // that email, trusting the provider's own email claim at face value.
  // An unverified or spoofed email claim from any provider would make
  // that a real account-takeover path, not just a convenience. Routing
  // both cases (email matched or not) through the same "prove you own
  // it" interstitial instead -- the did:guardian login_secret proof is
  // the actual security boundary here, not the email match, which only
  // ever shapes the message shown. The already-logged-in "connect a
  // provider" path (linkAgentUsername, above) is unaffected -- it was
  // never driven by an email match, only by the caller's own live
  // session, which is already a real proof of identity.
  const byEmail = identity.email ? await getAgentByEmail(env.DB, identity.email) : null;
  return notFoundInterstitial(
    byEmail
      ? `An existing zzmq.dev id is already registered with ${identity.email} -- sign in with it directly to confirm it's you and link this ${provider} login.`
      : `No zzmq.dev id is linked to this ${provider} login yet.`,
    cliNonce,
    true,
    [pendingLinkCookie({ provider, subject: identity.subject, accessTokenEnc, refreshTokenEnc, expiresAt, displayName: identity.displayName, email: identity.email })],
  );
}

function withExtraCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

/** The login page's "Sign in with did:guardian" form submission -- see guardianOidc.ts's own header for why an unknown domain fails here, before any redirect, rather than bouncing into a foreign error page. */
async function handleGuardianStart(request: Request, env: WebEnv): Promise<Response> {
  const cliNonce = new URL(request.url).searchParams.get("cli_nonce") ?? "";
  const form = await request.formData();
  const raw = String(form.get("identifier") ?? "");
  const parsed = parseGuardianIdentifier(raw);
  const pendingLinkSet = readPendingLink(request) !== null;
  if (!parsed) {
    return notFoundInterstitial(`"${raw}" doesn't look like a Guardian ID -- expected something like alice (your own zzmq.dev id), alice@acme.com, or @acme.com.`, cliNonce, pendingLinkSet);
  }
  const redirectUri = `${new URL(request.url).origin}/auth/callback/didguardian`;
  const state = shortId("state");
  const result = await buildGuardianAuthorizeUrl(env, parsed.domain, redirectUri, state, parsed.name);
  if (!result.ok) {
    return notFoundInterstitial(result.reason, cliNonce, pendingLinkSet);
  }
  const cookies = [
    `zz_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    `zz_guardian_domain=${encodeURIComponent(parsed.domain)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
  ];
  if (cliNonce) cookies.push(`zz_cli_nonce=${cliNonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  return redirect(result.url, { cookies });
}

async function handleGuardianAuthCallback(request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieState = cookieHeader.match(/zz_oauth_state=([^;]+)/)?.[1];
  const domain = cookieHeader.match(/zz_guardian_domain=([^;]+)/)?.[1];
  const cliNonce = cookieHeader.match(/zz_cli_nonce=([^;]+)/)?.[1];
  if (!code || !state || !domain || state !== cookieState) {
    return new Response("Sign-in state mismatch or missing code -- please try again.", { status: 400 });
  }

  const redirectUri = `${url.origin}/auth/callback/didguardian`;
  const identity = await exchangeGuardianCode(env, decodeURIComponent(domain), code, redirectUri);
  if (!identity) {
    return notFoundInterstitial(`Couldn't verify that Guardian ID against ${decodeURIComponent(domain)}.`, cliNonce, readPendingLink(request) !== null);
  }

  const agent = await resolveOrCreateAgentForDid(env, identity.did);
  const pendingLink = readPendingLink(request);
  if (pendingLink) {
    await bindProviderIdentity(env, agent, pendingLink);
    await refreshAgentProfile(env.DB, agent.username, pendingLink.displayName, pendingLink.email);
  }
  const response = await finishInteractiveLogin(env, agent, cliNonce);
  return pendingLink ? withExtraCookie(response, CLEAR_PENDING_LINK_COOKIE) : response;
}

/** A reasonable starting suggestion for the name-picker -- never authoritative, the registrar's own 409 is what actually enforces uniqueness. */
function suggestGuardianName(seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/@.*/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 3 ? slug.slice(0, 32) : `agent-${shortId("").slice(1, 7)}`;
}

function guardianNameForm(suggested: string, error: string | null, cliNonce: string | undefined): Response {
  const qs = cliNonce ? `?cli_nonce=${encodeURIComponent(cliNonce)}` : "";
  return layout(
    "Choose your id",
    null,
    `<div class="card stack" style="max-width:420px;margin:0 auto">
       ${error ? `<p class="hint" style="color:var(--pico-del-color,#c33)">${esc(error)}</p>` : ""}
       <p>Pick a name for your Guardian ID on zzmq.dev -- this is yours permanently, and it's how others (and you, from the CLI) will address it.</p>
       <form method="post" action="/onboard/guardian-name${qs}" class="stack">
         <label for="guardian-name">Name</label>
         <input id="guardian-name" name="name" value="${esc(suggested)}" pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" required>
         <button style="width:100%;padding:.85rem 1.1rem" type="submit">Create ${esc(suggested)}@zzmq.dev</button>
       </form>
     </div>`,
    { centerTitle: true },
  );
}

async function handleGuardianNameFormGet(request: Request, env: WebEnv): Promise<Response> {
  const cliNonce = new URL(request.url).searchParams.get("cli_nonce") ?? "";
  const pendingLink = readPendingLink(request);
  const suggested = suggestGuardianName(pendingLink?.email ?? pendingLink?.displayName ?? "");
  return guardianNameForm(suggested, null, cliNonce);
}

async function handleGuardianNameFormPost(request: Request, env: WebEnv): Promise<Response> {
  const cliNonce = new URL(request.url).searchParams.get("cli_nonce") ?? "";
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim().toLowerCase();
  if (!GUARDIAN_NAME_RE.test(name)) {
    return guardianNameForm(name || "alice", "That name must be 3-32 lowercase letters, digits, or hyphens, starting and ending with a letter or digit.", cliNonce);
  }

  const result = await registerGuardianName(env, name);
  if (!result.ok) {
    const message = result.status === 409 ? `"${name}" is already taken -- try another.` : result.message;
    return guardianNameForm(name, message, cliNonce);
  }

  // Unlike a managed agent (doRegisterManagedIdentity), a human here is
  // creating their own primary account directly -- there's no later
  // self-naming bootstrap for a human the way #21's is for an agent, so
  // this falls back to the did:guardian name they just chose rather than
  // leaving display_name empty with no way to ever set one.
  const pendingLink = readPendingLink(request);
  const agent = await createAgent(env.DB, result.did, pendingLink?.displayName ?? name, pendingLink?.email ?? null, null);
  if (pendingLink) await bindProviderIdentity(env, agent, pendingLink);
  if (pendingLink?.email) await setGuardianContactEmail(env, name, pendingLink.email);

  const secretCard = `<div class="card stack">
     <p>Your Guardian ID login secret -- copy it now, it won't be shown again. You'll need it to sign in with <code>${esc(name)}@zzmq.dev</code> directly (no OAuth provider) later:</p>
     <div class="clone-row"><pre>${esc(result.login_secret)}</pre><button class="secondary icon-btn" data-copy="${esc(result.login_secret)}" title="Copy">⧉</button></div>
   </div>`;
  const response = await finishInteractiveLogin(env, agent, cliNonce, secretCard);
  return pendingLink ? withExtraCookie(response, CLEAR_PENDING_LINK_COOKIE) : response;
}

/**
 * Only did:guardian identities zz itself can act on behalf of (zzmq.dev's
 * own, name-bearing ones -- zz holds no trusted-client credential at any
 * foreign registrar, and the bare-domain root identity has no login
 * secret at all) ever get offered "Regenerate login secret." Shared
 * between the profile page's own rendering and the POST handler so
 * neither can show/act on this for an identity it doesn't apply to.
 */
function ownGuardianName(username: string): string | null {
  const parsed = splitGuardianDid(username);
  return parsed && parsed.domain === "zzmq.dev" && parsed.name ? parsed.name : null;
}

async function handleReissueLoginSecret(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const name = ownGuardianName(me.username);
  if (!name) return redirect(`/${me.username}`);

  const result = await reissueGuardianLoginSecret(env, name);
  if (!result.ok) {
    return layout(
      "Couldn't reissue login secret",
      null,
      `<div class="card stack" style="max-width:420px;margin:0 auto">
         <p class="hint" style="color:var(--pico-del-color,#c33)">${esc(result.message)}</p>
         <a href="/${esc(me.username)}"><button class="secondary" style="width:100%">Back to profile</button></a>
       </div>`,
      { centerTitle: true },
    );
  }

  return layout(
    "New login secret",
    null,
    `<div class="card stack" style="max-width:480px;margin:0 auto">
       <p>Your old Guardian ID login secret no longer works. Copy this new one now -- it won't be shown again. You'll need it to sign in with <code>${esc(name)}@zzmq.dev</code> directly (no OAuth provider):</p>
       <div class="clone-row"><pre>${esc(result.login_secret)}</pre><button class="secondary icon-btn" data-copy="${esc(result.login_secret)}" title="Copy">⧉</button></div>
       <a href="/${esc(me.username)}"><button style="width:100%;padding:.85rem 1.1rem">Done</button></a>
     </div>`,
    { centerTitle: true },
  );
}

/** The web-profile counterpart to `zz agent rotate-key` -- self only (the own-profile page's own button; a managed agent's key rotates via the CLI command or its own settings action, not from here). */
async function handleRotateOwnKey(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const name = ownGuardianName(me.username);
  if (!name) return redirect(`/${me.username}`);

  const result = await rotateGuardianKey(env, name);
  if (!result.ok) {
    return layout(
      "Couldn't rotate key",
      null,
      `<div class="card stack" style="max-width:420px;margin:0 auto">
         <p class="hint" style="color:var(--pico-del-color,#c33)">${esc(result.message)}</p>
         <a href="/${esc(me.username)}"><button class="secondary" style="width:100%">Back to profile</button></a>
       </div>`,
      { centerTitle: true },
    );
  }

  return layout(
    "Key rotated",
    null,
    `<div class="card stack" style="max-width:480px;margin:0 auto">
       <p>Your Guardian ID's operational key has been rotated. Any bearer token you've already minted keeps working -- only the key used to sign future did:guardian operations changed.</p>
       <a href="/${esc(me.username)}"><button style="width:100%;padding:.85rem 1.1rem">Done</button></a>
     </div>`,
    { centerTitle: true },
  );
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
// #21: display_name is optional now -- an agent created with none is
// "unnamed," gated into choosing its own real name the first time it
// actually runs (zz work's own bootstrap, agent_set_name), rather
// than a human being required to supply one up front.
async function doCreateAgent(env: WebEnv, creator: Agent, displayName: string | null | undefined): Promise<{ agent: Agent; token: string }> {
  const trimmed = displayName?.trim() ?? "";
  const { agent, token } = await doRegisterManagedIdentity(env, creator, trimmed || undefined, trimmed);
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

/**
 * Rotates an agent's own custodied did:guardian operational key --
 * same authority bar as minting it a new bearer token
 * (requireTokenMintAuthority): yourself, or an agent you created. A
 * zzat-* bearer token (this function never touches those) and the
 * underlying did:guardian key (what this does rotate) are two
 * completely separate credentials; see guardianClient.ts's own
 * rotateGuardianKey for why this has to go through the registrar at
 * all rather than being computed here. Only an agent actually
 * registered on zzmq.dev's own registrar (ownGuardianName returning
 * non-null) has a key to rotate this way -- a foreign-registrar
 * identity's key rotation is that registrar's own concern, out of
 * reach from here by construction.
 */
async function doRotateKey(env: WebEnv, actor: Agent, targetUsername: string): Promise<{ agent: Agent; document: unknown }> {
  const target = await requireTokenMintAuthority(env, actor, targetUsername);
  const name = ownGuardianName(target.username);
  if (!name) throw new ApiError(400, `"${target.username}" isn't a zzmq.dev-registered identity -- its key rotation (if any) is its own registrar's concern`);
  const result = await rotateGuardianKey(env, name);
  if (!result.ok) throw new ApiError(502, result.message);
  return { agent: target, document: result.document };
}

/**
 * #23/#26: the one, canonical managed-identity registration -- the
 * caller as a real, signed guardian from day one (never ownerless), via
 * the atomic registrar capability. `zz agent create`/the web UI's "add
 * agent" (doCreateAgent above) and `zz work --register` are two entry
 * points to this same operation, not two different registration schemes.
 * `seedName` (slugified, negotiated for uniqueness -- see
 * registerManagedGuardianIdentity) becomes the did:guardian name itself;
 * `displayName` is independent and optional -- #21's own "unnamed, self-
 * names later" convention stays intact regardless of what name the
 * registrar actually negotiated.
 */
async function doRegisterManagedIdentity(env: WebEnv, actor: Agent, seedName: string | undefined, displayName = ""): Promise<{ agent: Agent; token: string; did: string }> {
  const result = await registerManagedGuardianIdentity(env, actor.username, seedName);
  if (!result.ok) throw new ApiError(502, result.message);
  const agent = await createAgent(env.DB, result.did, displayName, null, actor.username);
  const token = generateAgentToken();
  await createAgentToken(env.DB, agent.username, hashAgentToken(token));
  return { agent, token, did: result.did };
}

/**
 * `zz work --as <name-or-name@domain>`: resolves a did:guardian identity --
 * on zzmq.dev or any other registrar -- the caller is currently a real,
 * signed guardian of, and mints a fresh token for it. A bare zzmq.dev name
 * that doesn't already have a local agent row is a clear failure (those
 * are only ever created through the name-picker or --register, never
 * here); a foreign DID gets a minimal local agent row created lazily on
 * first successful resolution, same as a browser-based did:guardian login
 * does (resolveOrCreateAgentForDid). "Am I a guardian" is always checked
 * live against the identity's current operation log, never trusted from
 * any cached state (spec §4.8 -- guardian status is a live reference, not
 * a frozen key).
 */
async function doResolveManagedIdentity(env: WebEnv, actor: Agent, identifier: string): Promise<{ agent: Agent; token: string }> {
  const parsed = parseGuardianIdentifier(identifier.includes("@") ? identifier : `${identifier}@zzmq.dev`);
  if (!parsed) throw new ApiError(400, `"${identifier}" doesn't look like a valid id`);
  const did = parsed.name ? `did:guardian:${parsed.name}:${parsed.domain}` : `did:guardian:${parsed.domain}`;

  let agent = await getAgent(env.DB, did);
  if (!agent) {
    if (parsed.domain === "zzmq.dev") throw new ApiError(404, `no such id "${identifier}" -- it may not exist yet (see --register)`);
    agent = await resolveOrCreateAgentForDid(env, did);
  }

  const guardians = await currentGuardians(env, parsed.name, parsed.domain);
  if (!guardians) throw new ApiError(502, `couldn't resolve "${identifier}"`);
  if (!guardians.includes(actor.username)) {
    throw new ApiError(403, `you aren't currently a guardian of "${identifier}"`);
  }

  const token = generateAgentToken();
  await createAgentToken(env.DB, agent.username, hashAgentToken(token));
  return { agent, token };
}

/** Only a managed agent, and only by the human/agent that created it -- never a bare login account (that's a much bigger "delete my whole account" action, not built here) and never by some other creator's say-so. Refuses if the agent owns a repo, holds a repo Role grant, or created an agent that still exists -- those are live state that would be orphaned, not just Lane history (which stays exactly as it is either way: deleting the account row never rewrites it). */
/**
 * Releases every claim this agent holds (in a repo it owns or holds a
 * Role on -- the only repos reliably findable for it; an agent that
 * only ever claimed open-scope work in some unrelated public repo it
 * has no tracked connection to is a real gap, not solved here), deletes
 * its own shards, revokes whatever Role grants are left, then removes
 * its tokens/identities/sessions/agent row. Refuses outright if it
 * owns a genuine, non-shard repo -- that's a real, independent repo,
 * not disposable scratch state, and deleting the agent should never
 * silently take it along.
 *
 * Lane history is never touched by any of this -- every ASK/ANSWER/
 * INSIGHT this agent ever posted stays exactly as it is, in whatever
 * repo it posted to, forever, same as a real person's name still
 * showing on old commits after their account is gone. That's enough
 * to audit what a deleted agent did from inside any one repo's own
 * history. A cross-repo "everything this account ever did, anywhere,
 * even after it's deleted" view is a real, separate feature this
 * doesn't attempt -- noted here as a known future need, not shimmed
 * further than this comment until there's an actual design for
 * long-term retention of that.
 */
async function doDeleteAgent(env: WebEnv, actor: Agent, targetUsername: string): Promise<void> {
  const target = await getAgent(env.DB, targetUsername);
  if (!target) throw new ApiError(404, "no such agent");
  if (!target.created_by) throw new ApiError(400, `"${targetUsername}" is a login account, not a managed agent -- this only deletes managed agents`);
  if (target.created_by !== actor.username) throw new ApiError(403, `only "${target.created_by}", who created "${targetUsername}", can delete it`);
  const createdAgents = await agentsCreatedByStillExist(env.DB, targetUsername);
  if (createdAgents.length) {
    throw new ApiError(409, `can't delete "${targetUsername}": created ${createdAgents.length} agent(s) that still exist (${createdAgents.join(", ")}) -- delete those first`);
  }

  const [owned, roled] = await Promise.all([listReposOwnedBy(env.DB, targetUsername), listRepoRolesForAgent(env.DB, targetUsername)]);
  const nonShardOwned = owned.filter((r) => !r.shard_of_slug);
  if (nonShardOwned.length) {
    throw new ApiError(409, `can't delete "${targetUsername}": owns ${nonShardOwned.length} Lane(s) of its own (${nonShardOwned.map((r) => r.slug).join(", ")}) -- transfer or delete those first`);
  }

  const connected = new Map<string, string>(); // slug -> artifacts_name, every repo this agent has a tracked connection to
  for (const r of [...owned, ...roled]) connected.set(r.slug, r.artifacts_name);
  for (const [slug, artifactsName] of connected) {
    const stub = doStub(env, artifactsName);
    await stub.configure(artifactsName);
    const lanes = (await stub.callTool("lane_list", {})) as Lane[];
    for (const lane of lanes) {
      for (const entry of lane.history) {
        if (entry.type !== "ASK" || claimHolder(lane, entry.id) !== targetUsername) continue;
        try {
          await stub.callTool("ask_release", { repo: slug, lane_id: lane.id, ask_id: entry.id, actor: targetUsername });
        } catch {
          // Best-effort -- an ask that got answered by something else a
          // moment ago isn't a reason to abandon the rest of the cleanup.
        }
      }
    }
  }

  for (const r of owned) {
    await deleteShardTreeOf(env, r.slug);
    await doDeleteRepo(env, target, r.slug);
  }
  for (const r of roled) {
    if (owned.some((o) => o.slug === r.slug)) continue; // already gone above
    try {
      await doRevokeGrant(env, actor, r.slug, targetUsername);
    } catch {
      // Best-effort -- actor isn't necessarily an Owner of every repo
      // this agent happened to hold a Role on (someone else could have
      // granted it one independently of the creator relationship); an
      // orphaned repo_roles row referencing a now-deleted agent is
      // inert, not a correctness problem, so this doesn't block deletion.
    }
  }

  await deleteAgent(env.DB, targetUsername);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

/** The repo URL's owner segment, and the segment at /<username> for this Agent's own profile page. Frozen at creation (accountsDb.ts's createAgent) rather than recomputed live from display_name -- see migration 0003's header for why that matters. */
/** A new repo's own slug (and, via doCreateRepo's lane_propose, its origin Lane's default name/objective) embeds this as its owner segment -- the stylized "name@domain"/"@domain" display form, never the raw DID, per direct instruction. identifierToDid resolves this form straight back to the real agent wherever it's used as a lookup (e.g. this same repo page's own link back to its owner's profile). */
function ownerUrlSegment(agent: Agent): string {
  const parsed = splitGuardianDid(agent.username);
  if (!parsed) return agent.username;
  return parsed.name ? `${parsed.name}@${parsed.domain}` : `@${parsed.domain}`;
}

// A new repo's Ladder is bootstrapped mechanically, never via an LLM
// call -- repo creation has to stay fast and free, and "fold in a
// summary" (the one case ladder_write_rung's own CUMULATIVE_SUMMARY_KINDS
// handling calls a model) only triggers when a rung ALREADY has a
// summary to fold against, which a brand-new repo never does. Since
// there's no model call to lean on, these are hand-written explanations
// of what a README/LICENSE actually IS and does -- a fixed "added."
// would be technically true but tell a reader nothing they couldn't
// already see from the filename.
function buildInitialLadderRungs(opts: { description: string | null; ownerName: string; repoName: string; sha: string; license: LicenseOption | null }): Rung[] {
  const at = new Date().toISOString();
  const source = (title: string) => [{ kind: "commit" as const, ref: opts.sha, title, author: opts.ownerName, at }];

  const trimmedDescription = opts.description?.trim().replace(/\.$/, "") || null;
  const readmeSummary = `A README introducing the "${opts.repoName}" repository${trimmedDescription ? ` -- ${trimmedDescription}` : ""}. A README is the front door of an open-source project: the first document most visitors read, explaining what it does and how to use it.`;
  const licenseSummary = opts.license
    ? `The ${opts.license.name} license text. ${opts.license.blurb} A LICENSE file is what makes a repository's code legally reusable by others -- without one, the default under copyright law is "all rights reserved."`
    : null;

  const readmeRung: Rung = { path: "README.md", kind: "file", summary: readmeSummary, sources: source("Initial commit"), children: [] };
  const licenseRung: Rung | null = opts.license && licenseSummary ? { path: "LICENSE", kind: "file", summary: licenseSummary, sources: source("Initial commit"), children: [] } : null;

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
      { path: "README.md", kind: "filechange", summary: `Added. ${readmeSummary}`, sources: source("Initial commit"), children: [] },
      ...(opts.license && licenseSummary ? [{ path: "LICENSE", kind: "filechange" as const, summary: `Added. ${licenseSummary}`, sources: source("Initial commit"), children: [] }] : []),
    ],
  };

  const repoRung: Rung = {
    path: REPO_RUNG_PATH,
    kind: "repo",
    summary: `${trimmedDescription ?? "No description"}. Contains README.md${opts.license ? ` and a ${opts.license.name} LICENSE` : ""}.`,
    sources: source("Initial commit"),
    children: [],
  };

  return [repoRung, readmeRung, ...(licenseRung ? [licenseRung] : []), changesetRung];
}

// #66: temporary timing instrumentation -- doCreateRepo is confirmed
// live to take 10+ seconds for a single, brand-new, empty repo, and
// nobody's actually measured where that time goes yet (the step
// sequence below is a real guess at the likely dominant costs, not a
// profile). Logs one line per step so a real wrangler tail session
// against a real create can show the actual breakdown before anyone
// reorders/parallelizes anything based on a guess. Remove once #66's
// real bottleneck is found and fixed.
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[doCreateRepo timing] ${label}: ${Date.now() - start}ms`);
  }
}

async function doCreateRepo(env: WebEnv, owner: Agent, name: string, description: string | null, licenseKey: string | null): Promise<RepoRow> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ApiError(400, "name must match [A-Za-z0-9._-]+");
  const artifactsName = shortId("repo");
  const slug = `${ownerUrlSegment(owner)}/${slugify(name)}`;
  const license = licenseKey ? LICENSES[licenseKey] : null;
  const overallStart = Date.now();

  const created = await timed("ARTIFACTS.create", () => env.ARTIFACTS.create(artifactsName, { description: description ?? undefined, setDefaultBranch: "main" }));
  using repo = await timed("ARTIFACTS.get", () => env.ARTIFACTS.get(artifactsName));
  const token = await timed("repo.createToken", () => repo.createToken("write", 3600));
  // commit_changeset (and anything else that anchors to a commit) needs
  // a parent to diff against -- a brand new repo has none, so seed one.
  const readmeContent = `# ${name}\n\n${description ?? ""}\n`;
  const files = [{ path: "README.md", content: readmeContent }];
  // #21/#26: an unnamed agent (display_name null until it self-names)
  // still needs *something* real for a commit author/license text --
  // its own did:guardian name (not the raw DID string) is always
  // present and reasonable, unlike a placeholder.
  const ownerParsedDid = splitGuardianDid(owner.username);
  const ownerFallbackName = ownerParsedDid?.name ?? ownerParsedDid?.domain ?? owner.username;
  const ownerDisplayName = owner.display_name || ownerFallbackName;
  if (license) files.push({ path: "LICENSE", content: license.text(ownerDisplayName, new Date().getFullYear()) });
  // The agent's own real did:guardian email address (forwards to its
  // contact email, per the registrar's own email-proxying feature) when
  // it has no separate contact email on file -- a real, resolvable
  // address, not a fake placeholder.
  const ownerFallbackEmail = ownerParsedDid ? `${ownerParsedDid.name ?? "root"}@${ownerParsedDid.domain}` : `${owner.username}@zz.local`;
  const sha = await timed("createInitialCommit", () => createInitialCommit(created.remote, token, files, { name: ownerDisplayName, email: owner.email ?? ownerFallbackEmail }));
  await timed("ensureMeta", () => ensureMeta(created.remote, token, { description: description ?? "", owner: owner.username }));
  const row = await timed("upsertRepo", () => upsertRepo(env.DB, { slug, artifactsName, description, ownerUsername: owner.username }));
  await timed("syncRepoRoleCache", () => syncRepoRoleCache(env.DB, row.slug, [{ principal: owner.username, role: "owner", granted_by: "system", at: row.created_at }]));
  // Tracking is just a personal bookmark (trackRepo's own doc comment),
  // not an RBAC grant -- but a repo its own creator can't see in `zz
  // top` without a separate manual `zz repo track` first is a bad
  // default, confirmed live as a real surprise.
  await timed("trackRepo", () => trackRepo(env.DB, owner.username, row.slug));

  const rungs = buildInitialLadderRungs({ description, ownerName: ownerDisplayName, repoName: name, sha, license });
  const stub = doStub(env, artifactsName);
  await timed("stub.configure", () => stub.configure(artifactsName));
  await timed("ladder_write_rung", () => stub.callTool("ladder_write_rung", { repo: artifactsName, rung: rungs }));
  // The repo's own long-lived root Lane -- matches cli/commands/
  // ladder-build.ts's identical bootstrap for the local onboarding
  // path. Without this, lane_list on a brand-new repo returned []
  // (not just "no history yet", genuinely no Lane at all), which is
  // why a freshly created repo looked completely unreachable from zz
  // top's protocol/lanes tabs, not just empty -- confirmed live.
  //
  // id: ORIGIN_LANE_ID, not REPO_RUNG_PATH -- a real, previously
  // latent bug this rename exposed: these two constants mean
  // genuinely different things (the Lane's own id vs. the Ladder's
  // root rung path) and only ever happened to share the same literal
  // value ("_repo") before #60's rename. Using the wrong one here
  // silently still "worked" purely by that coincidence -- confirmed
  // live, caught by this exact call producing a Lane id of "_repo"
  // after the rename instead of the new "origin".
  await timed("lane_propose", () =>
    stub.callTool("lane_propose", { repo: artifactsName, id: ORIGIN_LANE_ID, name: slug, objective: `the ${slug} repository`, scope: ["**"], actor: owner.username, owners: [owner.username] }),
  );
  console.log(`[doCreateRepo timing] TOTAL: ${Date.now() - overallStart}ms`);

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

/**
 * #42: the new repo's own owner set and Policy at fork time -- a
 * one-time snapshot, never a live link, same discipline as the
 * trust-inheritance design this issue's own proposal cites. "sole"
 * (default) is just the forking actor, matching every fork shipped
 * before this existed; "union" is that actor added on top of
 * `fromRow`'s own CURRENT owners, read live at this exact moment -- a
 * later change to fromRow's own owners never retroactively alters
 * anything already forked from it, in either direction. The Policy
 * itself is snapshotted the same way (the whole document, not just
 * this one field) rather than starting a fork from DEFAULT_REPO_POLICY
 * regardless of what its own parent actually had configured.
 */
async function resolveForkSnapshot(env: WebEnv, fromRow: RepoRow, actorUsername: string): Promise<{ owners: string[]; policy: RepoPolicy }> {
  const ctx = await getRepoAccessContext(fromRow.slug, env);
  const policy = ctx?.meta ? normalizePolicy(ctx.meta.policy) : DEFAULT_REPO_POLICY;
  const owners = policy.fork_ownership === "union" && ctx ? Array.from(new Set([...ctx.lane.owners, actorUsername])) : [actorUsername];
  return { owners, policy };
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
  const { owners, policy } = await resolveForkSnapshot(env, parentRow, actor.username);
  await writeRepoMeta(created.remote, token, {
    description: taskText,
    policy,
    owner: actor.username,
    shard_of: parentSlug,
    created_at: now,
  });
  await writeRepoRoles(created.remote, token, { grants: owners.map((principal) => ({ principal, role: "owner" as const, granted_by: "system", at: now })) });

  const row = await upsertRepo(env.DB, { slug, artifactsName, description: taskText, ownerUsername: actor.username, shardOfSlug: parentSlug });
  await syncRepoRoleCache(env.DB, row.slug, [{ principal: actor.username, role: "owner", granted_by: "system", at: row.created_at }]);
  // Same reasoning as doCreateRepo: the agent that just claimed this
  // task should see its own shard in `zz top` right away, not after a
  // separate manual track.
  await trackRepo(env.DB, actor.username, row.slug);
  return row;
}

/**
 * #59: `zz lane create <name> --from <owner/lane>` -- the explicit,
 * user-named counterpart to ensureShard's own implicit, task-named one
 * above. Same real fork (ArtifactsRepo.fork, full history, zz-meta
 * carried over) and the same shard_of lineage tracking (so the
 * existing promotion/ownership-transfer machinery and the "related
 * Lanes" listing both already work correctly for this too, not just
 * for an automatic claim), but slugged from the name the caller
 * actually chose (owner/name, same convention doCreateRepo uses), not
 * an auto-generated task slug -- and, unlike ensureShard, this creates
 * its own origin Lane eagerly, right here, rather than leaving it to
 * be bootstrapped lazily on first post. `origin` is the new Lane's
 * origin pointer -- already resolved by the caller to real
 * artifacts_name/lane_id values, defaulting to `fromRow`'s own origin
 * Lane unless the caller explicitly asked for something else.
 */
async function doForkRepo(env: WebEnv, fromRow: RepoRow, actor: Agent, name: string, description: string | null, origin: { repo: string; lane: string }): Promise<RepoRow> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ApiError(400, "name must match [A-Za-z0-9._-]+");
  const artifactsName = shortId("repo");
  const slug = `${ownerUrlSegment(actor)}/${slugify(name)}`;
  if (await getRepoBySlug(env.DB, slug)) throw new ApiError(409, `"${slug}" already exists`);

  using fromRepo = await env.ARTIFACTS.get(fromRow.artifacts_name);
  const created = await fromRepo.fork(artifactsName, { description: description ?? undefined });
  using newRepo = await env.ARTIFACTS.get(artifactsName);
  const token = await newRepo.createToken("write", 3600);

  // Same reasoning as ensureShard's own identical comment: fork()
  // carries the parent's zz-meta branch over regardless of
  // defaultBranchOnly, so this always needs fresh values written, not
  // inherited ones.
  const now = new Date().toISOString();
  const { owners, policy } = await resolveForkSnapshot(env, fromRow, actor.username);
  await writeRepoMeta(created.remote, token, { description: description ?? "", policy, owner: actor.username, shard_of: fromRow.slug, created_at: now });
  await writeRepoRoles(created.remote, token, { grants: owners.map((principal) => ({ principal, role: "owner" as const, granted_by: "system", at: now })) });

  const row = await upsertRepo(env.DB, { slug, artifactsName, description, ownerUsername: actor.username, shardOfSlug: fromRow.slug });
  await syncRepoRoleCache(env.DB, row.slug, owners.map((principal) => ({ principal, role: "owner" as const, granted_by: "system", at: row.created_at })));
  await trackRepo(env.DB, actor.username, row.slug);

  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  await stub.callTool("lane_propose", {
    repo: artifactsName,
    id: ORIGIN_LANE_ID,
    name: slug,
    objective: description || `the ${slug} repository`,
    scope: ["**"],
    actor: actor.username,
    owners,
    origin_lane: origin.lane,
    origin_repo: origin.repo,
  });
  return row;
}

// Old repo-level Role -> new Lane tier (#41) -- contributor collapses
// into viewer (laneHasAnyGrant's own doc comment; a direct audit
// found nothing anywhere that actually enforced a difference).
function laneTierFor(role: RbacRole): "owner" | "coordinator" | "viewer" {
  return role === "owner" ? "owner" : role === "coordinator" ? "coordinator" : "viewer";
}

async function doRbacGrant(env: WebEnv, actor: Agent, repoSlug: string, principal: string, role: RbacRole): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such Lane");
  if (!(await getAgent(env.DB, principal))) throw new ApiError(404, `no such agent "${principal}"`);

  // No more "or any agent I created" indirection -- peers means the
  // ACTOR's own standing is what's checked, full stop, same as every
  // other RBAC check in this codebase (canReadRepo/canPushRepo). Kept
  // at Owner-only here even though lane_grant's own internal gate
  // would allow a Coordinator to grant coordinator/viewer -- this API
  // endpoint's authority bar doesn't widen just because the mechanism
  // under it moved (#41). `roles: null` -- ensureOriginLaneRoles's
  // migration fallback only matters for a repo nothing has ever
  // resolved the origin Lane for yet; by the time anyone can name it
  // as a grant target here, getRepoAccessContext (every page view)
  // has already migrated it.
  const lane = await requireLaneOwner(env, repo, null, actor, repoSlug);
  const stub = doStub(env, repo.artifacts_name);
  await stub.configure(repo.artifacts_name);
  await stub.callTool("lane_grant", { repo: repo.artifacts_name, lane_id: ORIGIN_LANE_ID, principal, as: laneTierFor(role), actor: actor.username });
  const tier = laneTierFor(role);
  if (tier === "owner" && !lane.owners.includes(principal)) lane.owners.push(principal);
  if (tier === "coordinator" && !lane.coordinators.includes(principal)) lane.coordinators.push(principal);
  if (tier === "viewer" && !lane.viewers.includes(principal)) lane.viewers.push(principal);
  await syncRepoRoleCache(env.DB, repo.slug, laneGrantsForCache(lane));
}

/** Removes one grant by its exact stored `principal` value -- doesn't require it to resolve to a current agent, so a stale/orphaned grant can still be cleaned up. Tries all three tiers (a principal's exact current tier isn't known to the caller, and lane_revoke is a no-op for a list they're not actually on). */
async function doRevokeGrant(env: WebEnv, actor: Agent, repoSlug: string, principal: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such Lane");
  const lane = await requireLaneOwner(env, repo, null, actor, repoSlug);
  const stub = doStub(env, repo.artifacts_name);
  await stub.configure(repo.artifacts_name);
  for (const as of ["owner", "coordinator", "viewer"] as const) {
    if (as === "owner" && lane.owners.includes(principal) && lane.owners.length === 1) continue; // same last-owner protection lane_revoke itself enforces
    await stub.callTool("lane_revoke", { repo: repo.artifacts_name, lane_id: ORIGIN_LANE_ID, principal, as, actor: actor.username });
  }
  const updatedLane = (await stub.callTool("lane_get", { repo: repo.artifacts_name, lane_id: ORIGIN_LANE_ID })) as Lane;
  await syncRepoRoleCache(env.DB, repo.slug, laneGrantsForCache(updatedLane));
}

async function doSetVisibility(env: WebEnv, actor: Agent, repoSlug: string, visibility: "public" | "private"): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such Lane");
  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("write", 3600);
  const info = await artifactsRepo.info();
  const { meta, roles } = await readRepoMetaAndRoles(info.remote, token);
  if (!meta) throw new ApiError(404, "Lane has no metadata yet");
  await requireLaneOwner(env, repo, roles, actor, repoSlug);
  await writeRepoMeta(info.remote, token, { ...meta, policy: { ...meta.policy, visibility } });
  await updateRepoVisibility(env.DB, repo.slug, visibility);

  // Same cascade as an outright delete (GitHub's own rule: a public
  // repo going private splits its public forks off into their own
  // network) -- this repo, unlike a delete, keeps existing, so only
  // its SHARDS need detaching, not itself.
  if (visibility === "private" && repo.visibility === "public") {
    const shards = await listShardsOf(env.DB, repoSlug);
    if (shards.length > 0) await promoteShardAsNewOrigin(env, repo, shards);
  }
}

/** Ownership transfer keeps the repo's URL (slug) unchanged -- the slug is frozen at creation time off the ORIGINAL owner's username, same as a GitHub repo's path staying put after a transfer within the same org would. The new owner gets an explicit "owner" grant in roles.json; the previous owner's own grant is left as-is (not stripped), so transferring doesn't silently revoke their access -- they can demote themselves separately via the roles list if that's what they want. */
async function doTransferOwnership(env: WebEnv, actor: Agent, repoSlug: string, newOwnerUsername: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such Lane");
  const newOwner = await getAgent(env.DB, newOwnerUsername);
  if (!newOwner) throw new ApiError(404, "no such agent");
  using artifactsRepo = await env.ARTIFACTS.get(repo.artifacts_name);
  const token = await artifactsRepo.createToken("write", 3600);
  const info = await artifactsRepo.info();
  const { meta } = await readRepoMetaAndRoles(info.remote, token);
  if (!meta) throw new ApiError(404, "Lane has no metadata yet");
  const lane = await requireLaneOwner(env, repo, null, actor, repoSlug);

  await writeRepoMeta(info.remote, token, { ...meta, owner: newOwner.username });
  // The new owner gets an explicit Owner grant on the origin Lane;
  // the previous owner's own grant is left as-is (not stripped), same
  // "transferring doesn't silently revoke your own access" choice
  // this always made -- they can demote themselves separately if
  // that's what they want.
  const stub = doStub(env, repo.artifacts_name);
  await stub.configure(repo.artifacts_name);
  await stub.callTool("lane_grant", { repo: repo.artifacts_name, lane_id: ORIGIN_LANE_ID, principal: newOwner.username, as: "owner", actor: actor.username });
  if (!lane.owners.includes(newOwner.username)) lane.owners.push(newOwner.username);
  await syncRepoRoleCache(env.DB, repo.slug, laneGrantsForCache(lane));
  await updateRepoOwner(env.DB, repo.slug, newOwner.username);
}

async function doDeleteRepo(env: WebEnv, actor: Agent, repoSlug: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such Lane");

  try {
    await requireLaneOwner(env, repo, null, actor, repoSlug);
    await env.ARTIFACTS.delete(repo.artifacts_name);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (!(e instanceof Error)) throw e;
    // Any failure reading live Role state (the origin Lane, via the
    // DO) -- the repo gone already (confirmed live: "ArtifactsError:
    // Repository not found", an orphaned D1 row from some earlier
    // delete that cleared the Artifacts repo but failed before this
    // row), or its content/history too corrupted for the DO's own
    // reads to even parse (confirmed live on a long-lived shard repo:
    // some unidentified exception neither "not found" nor a clean
    // ApiError, crashing both this and the repo page itself) -- falls
    // back to
    // the D1 row's own recorded owner rather than leaving a repo stuck
    // forever undeletable by anyone, including its own real owner.
    // Same authorization bar either way, not a bypass: this still
    // requires `actor` to match `repo.owner_username` exactly.
    if (actor.username !== repo.owner_username) throw new ApiError(403, `${actor.username} is not an Owner of ${repoSlug}`);
    // Best-effort: if the repo is corrupted rather than already gone,
    // its Artifacts-side data is still sitting there taking up real
    // storage even once this clears the D1 row below. Worth one try,
    // never worth failing the whole delete over -- the D1 row (what
    // actually makes this slug reachable from anywhere) still clears
    // either way.
    try {
      await env.ARTIFACTS.delete(repo.artifacts_name);
    } catch {
      // already gone, or too corrupted to delete cleanly either --
      // either way, nothing more to do here.
    }
  }

  // Authorization is settled by this point either way (the try block
  // above, or its catch's own fallback check) -- never block a delete
  // just because shards exist, and never cascade-delete them either
  // (same choice GitHub makes: a shard is real content someone else
  // made, that happens to exist elsewhere). One gets promoted to take
  // over as the origin the rest point at instead.
  const shards = await listShardsOf(env.DB, repoSlug);
  if (shards.length > 0) await promoteShardAsNewOrigin(env, repo, shards);

  await deleteRepoRow(env.DB, repo.slug, repo.artifacts_name);
}

/**
 * GitHub's own fork-network behavior for an origin repo that's
 * deleted, or (doSetVisibility) made private while public shards still
 * exist: never blocks the operation, never cascade-deletes the shards.
 * Instead, exactly one shard is PROMOTED -- its own `shard_of_slug` set
 * to null, every other surviving shard (including ones that were never
 * forked from `origin` directly, just siblings of whichever shard gets
 * promoted) repointed at it instead.
 *
 * Picked by, in order:
 * 1. Fewest commits the origin made since that shard's own fork point
 *    (its own git log's newest commit also present in the origin's
 *    log, found by walking the shard's log newest-first until a
 *    shared commit turns up) -- the shard closest to what the origin
 *    actually was, not just the oldest or newest shard by creation
 *    time. A shard with no commit shared with the origin at all
 *    (shouldn't happen -- every shard starts as a real fork -- but
 *    cheap to guard) sorts last, never first, rather than crashing
 *    the whole promotion over one unreadable/divergent shard.
 * 2. Ties broken by whichever shard has the most recent protocol
 *    activity (an ASK/ANSWER/INSIGHT on any of its own Lanes) -- the
 *    one most likely still being actively worked, so the surviving
 *    network points at whoever's actually still around.
 */
async function promoteShardAsNewOrigin(env: WebEnv, origin: RepoRow, shards: RepoRow[]): Promise<void> {
  if (shards.length === 1) {
    await updateRepoShardOf(env.DB, shards[0].slug, null);
    return;
  }

  let originIndexOf = new Map<string, number>();
  try {
    using originRepo = await env.ARTIFACTS.get(origin.artifacts_name);
    const originInfo = await originRepo.info();
    const originLog = await originRepo.log({ ref: originInfo.defaultBranch, limit: 1000 });
    originIndexOf = new Map(originLog.map((c, i) => [c.hash, i]));
  } catch {
    // Origin's own content already unreadable (the corrupted-repo case
    // this same session found) -- every shard ties on "behind," so the
    // tie-break (most recent protocol activity) decides alone.
  }

  let best: { row: RepoRow; behind: number; lastActivity: string } | null = null;
  for (const shard of shards) {
    let behind = Number.POSITIVE_INFINITY;
    try {
      using shardRepo = await env.ARTIFACTS.get(shard.artifacts_name);
      const shardInfo = await shardRepo.info();
      const shardLog = await shardRepo.log({ ref: shardInfo.defaultBranch, limit: 1000 });
      const common = shardLog.find((c) => originIndexOf.has(c.hash));
      if (common) behind = originIndexOf.get(common.hash)!;
    } catch {
      // This shard's own content unreadable -- last choice, not a
      // reason to fail the whole promotion.
    }
    const lanes = await getAllLanes(env, shard.artifacts_name).catch(() => []);
    const lastActivity = flattenProtocol(lanes)[0]?.entry.at ?? shard.created_at;
    if (!best || behind < best.behind || (behind === best.behind && lastActivity > best.lastActivity)) {
      best = { row: shard, behind, lastActivity };
    }
  }
  if (!best) return;

  await updateRepoShardOf(env.DB, best.row.slug, null);
  for (const shard of shards) {
    if (shard.slug === best.row.slug) continue;
    await updateRepoShardOf(env.DB, shard.slug, best.row.slug);
  }
}

interface ShardCleanupResult {
  deleted: number;
  failed: { slug: string; error: string }[];
}

/** Deletes every direct shard of `parentSlug`, and every shard of those shards, recursively (grandchildren before the shard whose children they are, so a shard's own shard_of_slug never points at an already-gone row mid-operation). No permission check of its own -- the caller (doCleanupShards) has already verified ownership of the top-level parent, and every repo reached from here is being torn down wholesale as part of that one decision, not individually authorized. Tolerates a shard whose Artifacts repo is already gone (same idempotency as doDeleteRepo's own orphan handling), since a shard tree can legitimately be mid-cleanup already.
 *
 * One shard failing (confirmed live: a transient Artifacts error, gone on retry) used to throw straight out of the loop, silently abandoning every sibling and deeper descendant still left to process -- which is exactly the "cleaned up some, left two behind, no error shown" report this fixes. Each shard's own failure is now caught and collected instead, so the rest of the tree still gets a chance; a shard whose OWN children failed to clean up is left alone too (not deleted out from under them), so nothing gets orphaned with no shard_of_slug parent left to find it through. */
async function deleteShardTreeOf(env: WebEnv, parentSlug: string): Promise<ShardCleanupResult> {
  const shards = await listShardsOf(env.DB, parentSlug);
  let deleted = 0;
  const failed: { slug: string; error: string }[] = [];
  for (const shard of shards) {
    try {
      const child = await deleteShardTreeOf(env, shard.slug);
      deleted += child.deleted;
      failed.push(...child.failed);
      if (child.failed.length > 0) continue;
      try {
        await env.ARTIFACTS.delete(shard.artifacts_name);
      } catch (e) {
        if (!(e instanceof Error) || !/not found/i.test(e.message)) throw e;
      }
      await deleteRepoRow(env.DB, shard.slug, shard.artifacts_name);
      deleted += 1;
    } catch (e) {
      failed.push({ slug: shard.slug, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { deleted, failed };
}

/** Owner-of-the-parent is the one check that matters -- every shard being wiped is a scratch workspace that exists only because of this repo's own task delegation, not a separately-owned repo someone else gets a say over. */
async function doCleanupShards(env: WebEnv, actor: Agent, repoSlug: string): Promise<ShardCleanupResult> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such Lane");
  await requireLaneOwner(env, repo, null, actor, repoSlug);
  return deleteShardTreeOf(env, repoSlug);
}

function doStub(env: WebEnv, artifactsName: string) {
  const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(artifactsName));
  return stub;
}

/** The origin Lane's full history -- every ASK/ANSWER posted via doPostAsk or the engine's own protocol. Null if the repo has no origin Lane yet (never had an Ask posted to it). Real `Lane` objects throughout (not a trimmed display type): claimableAsks (engine/workqueue.ts) needs the real shape (coordinators AND committee), and the DO already hands back exactly that. */
async function getRootLane(env: WebEnv, artifactsName: string): Promise<Lane | null> {
  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  return (await stub.callTool("lane_get", { repo: artifactsName, lane_id: ORIGIN_LANE_ID })) as Lane | null;
}

/** #62: a targeted single-Lane fetch (lane_get), not getAllLanes' own lane_list -- the Lane page's own live-polling fragments (handleLaneFragment) need just the one Lane a poll is scoped to, not every Lane in the repo, every few seconds. */
async function getLaneById(env: WebEnv, artifactsName: string, laneId: string): Promise<Lane | null> {
  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  return (await stub.callTool("lane_get", { repo: artifactsName, lane_id: laneId })) as Lane | null;
}

/**
 * The repo-level RBAC read every real enforcement call site now goes
 * through (#41) -- the origin Lane's own owners/coordinators/viewers,
 * not the retired roles.json/repo_roles cache. Bootstraps the origin
 * Lane if it's somehow still missing (same self-heal doPostAsk/
 * handleApiCallTool already do), then migrates a not-yet-migrated
 * Lane (owners still empty) from the repo's old roles.json grants,
 * exactly once -- MaintainerDO.seedOriginLaneRolesIfUnset's own gate
 * makes this safe to call unconditionally on every read, since it's a
 * permanent no-op for an already-migrated repo. `roles` is whatever
 * the caller already has in hand (most call sites already fetched it
 * for other reasons) -- null is fine, falls back to just the repo's
 * own owner_username.
 */
async function ensureOriginLaneRoles(env: WebEnv, repo: RepoRow, roles: RepoRoles | null): Promise<Lane> {
  const stub = doStub(env, repo.artifacts_name);
  await stub.configure(repo.artifacts_name);
  let lane = (await stub.callTool("lane_get", { repo: repo.artifacts_name, lane_id: ORIGIN_LANE_ID })) as Lane | null;
  if (!lane) {
    await stub.callTool("lane_propose", { repo: repo.artifacts_name, id: ORIGIN_LANE_ID, name: repo.slug, objective: `the ${repo.slug} repository`, scope: ["**"], actor: repo.owner_username, owners: [repo.owner_username] });
    lane = (await stub.callTool("lane_get", { repo: repo.artifacts_name, lane_id: ORIGIN_LANE_ID })) as Lane;
  }
  if (lane.owners.length > 0) return lane;

  const owners: string[] = [];
  const coordinators: string[] = [];
  const viewers: string[] = [];
  for (const g of roles?.grants ?? []) {
    if (g.role === "owner") owners.push(g.principal);
    else if (g.role === "coordinator") coordinators.push(g.principal);
    else viewers.push(g.principal); // contributor + viewer both collapse here (#41)
  }
  if (owners.length === 0) owners.push(repo.owner_username); // never leave a repo with zero owners
  await stub.seedOriginLaneRolesIfUnset(ORIGIN_LANE_ID, owners, coordinators, viewers);
  return (await stub.callTool("lane_get", { repo: repo.artifacts_name, lane_id: ORIGIN_LANE_ID })) as Lane;
}

/** Flattens the origin Lane's owners/coordinators/viewers into the flat grant-list shape syncRepoRoleCache (accountsDb.ts) already expects -- the repo_roles D1 cache's own shape predates #41 and doesn't need to change, just what populates it. granted_by/at are placeholders ("system", now) for every entry: the cache was never read for either field anywhere (confirmed by grep), only role itself (getRepoRoleForPrincipal) and the ordering of listMyRepos's own RBAC_RANK sort. */
function laneGrantsForCache(lane: Lane): { principal: string; role: string; granted_by: string; at: string }[] {
  const at = new Date().toISOString();
  // Deduped by principal, highest tier wins -- an owner is very often
  // ALSO in coordinators (proposeLane's own default seeds the
  // proposer, here the repo's owner, into coordinators regardless of
  // owners), and the D1 cache's own PRIMARY KEY is (repo_slug,
  // principal), one row per principal, not one per list membership.
  const best = new Map<string, string>();
  for (const p of lane.viewers) best.set(p, "viewer");
  for (const p of lane.coordinators) best.set(p, "coordinator");
  for (const p of lane.owners) best.set(p, "owner"); // owner last -- always wins the overwrite
  return [...best.entries()].map(([principal, role]) => ({ principal, role, granted_by: "system", at }));
}

/** The one owner-check every structural repo action (grant/revoke, delete, transfer, visibility/description change, shard cleanup) shares -- #41 moved all of them from roles.json's repoAtLeast(repoRoleFor(...), "owner") onto this. Throws the exact same ApiError shape every one of those call sites already threw, so this is a pure extraction, not a behavior change. */
async function requireLaneOwner(env: WebEnv, repo: RepoRow, roles: RepoRoles | null, actor: Agent, repoSlug: string): Promise<Lane> {
  const lane = await ensureOriginLaneRoles(env, repo, roles);
  if (!laneHasOwner(lane, actor.username)) throw new ApiError(403, `${actor.username} is not an Owner of ${repoSlug}`);
  return lane;
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

// Ladder tab: the repo's full Ladder tree, in one ladder_tree call --
// server-side resolved and durably cached (cloudflareBackend.ts's
// readLadderTree), invalidated only on an actual Ladder write.
// Replaces what used to be a manual, worker-side walk of repeated
// ladder_read calls (one per rung): confirmed live as a real
// performance bug (every one of those calls re-paid a full git-notes
// checkout, and the manual walk couldn't benefit from a cache that
// lived across separate stub.callTool invocations). This also means
// the web page's own first view of a repo is what warms the cache
// the TUI/CLI then benefits from too, and vice versa -- one cache,
// whichever side reads first.
async function getLadderTree(env: WebEnv, artifactsName: string): Promise<ResolvedRung | null> {
  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  return (await stub.callTool("ladder_tree", { repo: artifactsName })) as ResolvedRung | null;
}

// Fixed display order for the Ladder tab -- children of a node are
// accumulated over time in whatever order rungs happened to get
// written (a file touched by an early commit, then a changeset from a
// much later one, then another file, ...), which reads as shuffled.
// Grouping same-kind rungs together (all files, then all changesets,
// ...) makes the tab scannable without changing anything about the
// underlying tree.
const LADDER_KIND_ORDER: Record<string, number> = {
  repo: 0, directory: 1, file: 2, package: 3, release: 4,
  dependencies: 5, contributor: 6, changeset: 7, filechange: 8,
  function: 9, lines: 10, linechange: 11, ask: 12, answer: 13,
};

// A changeset rung's path IS "changesets/<sha>" and a filechange
// rung's is "changesets/<sha>/<path, which may itself contain '/'>"
// (see readLadderRung's own header comment) -- real places to go, not
// just an id to read: the commit itself, or that one file's content
// and inline diff at that exact commit. Every other kind's path isn't
// a commit-scoped locator the same way (a file/directory rung's path
// is its CURRENT-state location, not pinned to any one commit), so
// this is deliberately narrow rather than guessing a link for every kind.
/** A changeset rung's own path IS "changesets/<sha>" -- the sha, extracted here once and reused both for that rung's own commit link and, passed down to its filechange children, for theirs. */
function changesetShaOf(node: ResolvedRung): string | null {
  if (node.kind !== "changeset" || !node.path.startsWith("changesets/")) return null;
  return node.path.slice("changesets/".length);
}

/** parentChangesetSha: the nearest ancestor changeset's sha, threaded down from renderLadderNode -- a filechange rung's own path is just its bare filename (no "changesets/<sha>/" prefix; it's nested, not top-level, so nothing re-derives that context from the rung itself), so linking it to that file's content at that specific commit (where the blob view's own historical-ref handling shows the inline diff automatically) needs the parent's sha handed in. */
function ladderPathLink(slug: string, node: ResolvedRung, defaultBranch: string, parentChangesetSha: string | null): string | null {
  if (node.kind === "file") return `/${esc(slug)}/blob/${esc(defaultBranch)}/${esc(node.path)}`;
  if (node.kind === "changeset") {
    const sha = changesetShaOf(node);
    return sha ? `/${esc(slug)}/commit/${esc(sha)}` : null;
  }
  if (node.kind === "filechange" && parentChangesetSha) return `/${esc(slug)}/blob/${esc(parentChangesetSha)}/${esc(node.path)}`;
  return null;
}

function renderLadderNode(slug: string, node: ResolvedRung, defaultBranch: string, depth = 0, parentChangesetSha: string | null = null): string {
  const indent = "&nbsp;&nbsp;".repeat(depth);
  // data-search: lowercased path+summary+kind, read by the ladder
  // search box's own JS (zzInitLadderSearch) to decide whether to hide
  // this row -- a plain client-side filter over what's already
  // rendered, not a second query against anything.
  const searchable = esc(`${node.kind} ${node.path} ${node.summary}`.toLowerCase());
  const href = ladderPathLink(slug, node, defaultBranch, parentChangesetSha);
  const pathHtml = href ? `<a href="${href}" class="mono">${esc(node.path)}</a>` : `<span class="mono">${esc(node.path)}</span>`;
  const self = `<li class="row" data-search="${searchable}" data-kind="${esc(node.kind)}">${indent}<span class="rung">${esc(node.kind)}</span> ${pathHtml} <span class="muted">${esc(node.summary)}</span></li>`;
  // An ask's children are a conversation thread (ask/answer/ask/...)
  // in chronological order -- that sequence is the whole point, so
  // it's left alone rather than grouped by kind like everything else.
  const children = node.kind === "ask" ? node.children : [...node.children].sort((a, b) => (LADDER_KIND_ORDER[a.kind] ?? 99) - (LADDER_KIND_ORDER[b.kind] ?? 99));
  const childSha = changesetShaOf(node) ?? parentChangesetSha;
  return [self, ...children.map((c) => renderLadderNode(slug, c, defaultBranch, depth + 1, childSha))].join("");
}

// One rung read directly by its own path -- the commit/file view's
// "related Ladder" panel, not the whole-repo Ladder tab (getLadderTree
// above). A changeset rung's path IS the commit sha
// ("changesets/<sha>"), so this is a single direct read, no searching;
// same for a file rung (path IS the file's path). Non-ask children
// (a changeset's filechange entries, a file's function/line rungs)
// come back embedded already -- this doesn't walk further than that,
// since it's a small "related" panel, not a full tree resolve.
async function readLadderRung(env: WebEnv, artifactsName: string, path: string): Promise<EmbeddedRung | null> {
  const stub = doStub(env, artifactsName);
  await stub.configure(artifactsName);
  return (await stub.callTool("ladder_read", { repo: artifactsName, path })) as EmbeddedRung | null;
}

function renderLadderDetail(rung: EmbeddedRung, depth = 0): string {
  const indent = "&nbsp;&nbsp;".repeat(depth);
  const self = `<li class="row">${indent}<span class="rung">${esc(rung.kind)}</span> <span class="muted">${esc(rung.summary)}</span></li>`;
  // Ask-thread refs stay unresolved here -- this panel is a quick
  // "related" summary, not a place to follow conversation threads.
  const children = rung.children.filter((c): c is EmbeddedRung => !isRef(c)).map((c) => renderLadderDetail(c, depth + 1));
  return [self, ...children].join("");
}

/** Collapsed-by-default <details>, smaller text than the rest of the page -- one rung's own summary, attached directly to the thing it's about (a file, a commit), not a combined dump. */
function summaryDetailHtml(summary: string): string {
  return `<details class="summary-detail"><summary>Ladder Summary</summary><p class="muted">${esc(summary)}</p></details>`;
}

/** Same, but keeps a rung's own embedded (non-ask) children nested inside it -- only used where there's nowhere more specific yet to attach them (e.g. a file rung's function-level children, until line-anchored summaries exist). A commit's filechange children get attached to their own file row instead (handleCommit), not nested here. */
function ladderDetailHtml(rung: EmbeddedRung | null): string {
  if (!rung) return "";
  return `<details class="summary-detail"><summary>Ladder Summary</summary><ul class="list">${renderLadderDetail(rung)}</ul></details>`;
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
    // #32: repo Owners/Coordinators count toward committee-scope asks
    // automatically -- the origin Lane is already in this same batch.
    const originLane = lanes.find((l) => l.id === ORIGIN_LANE_ID) ?? null;
    for (const lane of lanes) {
      for (const ask of claimableAsks(lane, viewerUsername, originLane)) {
        out.push({ repoSlug: repo.slug, laneId: lane.id, ask });
      }
    }
  }
  return out;
}

async function doClaimAsk(env: WebEnv, actor: Agent, repoSlug: string, laneId: string, askId: string): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such Lane");
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
      `<p class="hint">Every open Ask across every Lane you can see that you're permitted to act on -- the same query \`zz work\` runs, just for a human clicking instead of an agent looping.</p>
       <ul class="list">${rows || '<li class="empty">Nothing claimable right now.</li>'}</ul>`,
    )}

     ${card(
       "Post an ask to a Lane's origin",
       `<form method="post" action="/work/ask" class="stack">
          <input name="repo_slug" placeholder="owner/name" required>
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
    <p class="hint">Posts your changes for review and marks this Ask complete -- the same protocol sequence a scripted agent follows (changeset_review + submit_changeset, then a human's \`zz review\` and a coordinator's \`zz work\` merge it), just with content you wrote instead of generated.</p>`;
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
       <p>Claimed <span class="badge badge-yellow">${esc(resolvedAsk?.kind ?? "?")}</span> on <a href="/${esc(repoSlug)}" class="mono" style="color:var(--pink)">${esc(repoSlug)}</a> (lane ${laneTagHtml(laneId, repoSlug)}).</p>
       ${resolvedAsk ? workInstructions(repoSlug, laneId, askId, resolvedAsk) : '<p class="hint">Could not load this Ask\'s details -- check its own page\'s Asks tab.</p>'}
       <p><a href="/work">&larr; Back to Work</a></p>
     </div>`,
  );
}

async function doPostAsk(env: WebEnv, actor: Agent, repoSlug: string, description: string, decompose?: boolean, laneId: string = ORIGIN_LANE_ID): Promise<void> {
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) throw new ApiError(404, "no such Lane");
  const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(repo.artifacts_name));
  await stub.configure(repo.artifacts_name);
  // The origin Lane isn't the same thing as the Ladder's root rung
  // (ensureMeta/writeRung territory) -- it's a real Lane, which
  // doCreateRepo never bootstrapped (confirmed live: posting an ask to
  // a repo created through the web/API threw "no such lane: _repo").
  // Lazily create it here, the same bootstrap demo/greenfield.ts's
  // local flow always did, so this self-heals for every repo already
  // created before this fix too, not just new ones. (These two used to
  // collide on the same bare "_repo" literal with no name of its own
  // for either sense -- see https://github.com/zzmq-dev/zz/issues/35.)
  // Only for the origin Lane specifically -- a non-origin lane_id is
  // never this repo's own bootstrap-missing case, it's just a bad id.
  if (laneId === ORIGIN_LANE_ID) {
    const existingLane = await stub.callTool("lane_get", { repo: repo.artifacts_name, lane_id: ORIGIN_LANE_ID });
    if (!existingLane) {
      await stub.callTool("lane_propose", { repo: repo.artifacts_name, id: ORIGIN_LANE_ID, name: repo.slug, objective: `the ${repo.slug} repository`, scope: ["**"], actor: repo.owner_username, owners: [repo.owner_username] });
    }
  }
  await stub.callTool("ask_post", { repo: repo.artifacts_name, lane_id: laneId, kind: "work", from: actor.username, payload: { description, ...(decompose ? { decompose: true } : {}) } });
}

// --- Agent profile: /<username> is BOTH the public view (anyone) and
// the private, editable view (when you're logged in as that agent) --
// no separate /profile route. See migration 0003's header for why
// `username` is a frozen, stored column rather than recomputed.

async function handleAgentPage(username: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  const pageAgent = await getAgent(env.DB, identifierToDid(username));
  if (!pageAgent) return new Response("no such agent", { status: 404 });

  if (me && me.username === pageAgent.username) return renderOwnProfile(me, env);
  return renderPublicProfile(pageAgent, request, env);
}

async function renderPublicProfile(agent: Agent, request: Request, env: WebEnv): Promise<Response> {
  // Every Lane this agent holds owner/coordinator/viewer/committee on
  // -- the real cross-repo index (migration 0018), not a fan-out.
  const agentLanes = await listLanesForPrincipal(env.DB, agent.username);
  const visibleRepoRows = new Map<string, RepoRow>();
  // Always a different viewer than `agent` here (handleAgentPage
  // routes you to renderOwnProfile for your own page instead), so a
  // Lane whose repo is mid-import never belongs on this list -- same
  // reasoning accountsDb.ts's INGEST_VISIBLE_CLAUSE gates search/
  // listing with. One access check per distinct repo, not per Lane.
  for (const slug of new Set(agentLanes.map((l) => l.lane.repo_slug))) {
    const ctx = await getRepoAccessContext(slug, env);
    if (ctx && ctx.repoRow.ingest_status !== "ingesting" && (await canReadRepo(request, env, ctx.meta, ctx.lane))) visibleRepoRows.set(slug, ctx.repoRow);
  }
  const visibleLanes = agentLanes.filter((l) => visibleRepoRows.has(l.lane.repo_slug)).map((l) => l.lane);
  const agentParsed = splitGuardianDid(agent.username);
  const agentDisplayName = agentParsed ? (agentParsed.name ? `${agentParsed.name}@${agentParsed.domain}` : `@${agentParsed.domain}`) : agent.username;

  return layout(
    agentDisplayName,
    await resolveRequestAgent(request, env),
    `${agentNameRecordHtml(agent)}
     ${card(
       "Lanes",
       `<ul class="list">${
         shardGroupedListHtml(
           visibleLanes,
           laneKey,
           laneOriginKey,
           (l) => `<a href="/${esc(l.repo_slug)}#lane-${esc(l.lane_id)}" class="mono" style="color:var(--pink)">${esc(l.name)}</a>${l.objective ? `<div class="muted">${autolinkText(l.objective)}</div>` : ""}`,
           "related Lane",
         ) || '<li class="empty">No public Lanes.</li>'
       }</ul>`,
     )}

     ${card("Activity", await agentActivityHtml(agent, [...visibleRepoRows.values()], env))}`,
    { h1Html: `${esc(agentDisplayName)} <span class="hint" style="font-size:.55em;font-weight:400">(${esc(agent.username)})</span>` },
  );
}

/** #21: the durable, public record of this agent's own name -- distinct from merely having a display_name (a human may have set one at creation), this specifically surfaces WHEN self-naming happened, not a silent field. */
function agentNameRecordHtml(agent: Agent): string {
  if (agent.named_at) return `<p class="muted">Chose its own name, "${esc(agent.display_name)}", on ${esc(agent.named_at.slice(0, 10))}.</p>`;
  if (!agent.display_name) return `<p class="muted">Not yet named -- chooses its own name the first time it runs <code>zz work</code>.</p>`;
  return "";
}

/**
 * This agent's own actions (`entry.from === agent.username`) across
 * every repo in `repos`, flattened and rendered the same way one
 * repo's own Activity tab is -- the caller has already decided which
 * repos are visible here (a different rule for your own profile,
 * which sees every repo you're connected to, than for someone looking
 * at your public one, which only sees what it can actually read).
 *
 * Bounded by what's actually trackable: `repos` only ever comes from
 * ownership or an explicit Role grant (see both call sites) -- a repo
 * this agent only ever posted open-scope work into, with neither,
 * isn't findable here. There's no index of "every repo an agent has
 * ever touched" to walk instead; building one is a real, separate
 * feature, not attempted here.
 */
async function agentActivityHtml(agent: Agent, repos: RepoRow[], env: WebEnv): Promise<string> {
  const perRepo = await Promise.all(
    repos.map(async (r) => {
      const stub = doStub(env, r.artifacts_name);
      await stub.configure(r.artifacts_name);
      const lanes = (await stub.callTool("lane_list", {})) as Lane[];
      return flattenProtocol(lanes).map((e) => ({ ...e, repoSlug: r.slug }));
    }),
  );
  const mine = perRepo
    .flat()
    .filter(({ entry }) => entry.from === agent.username)
    .sort((a, b) => (a.entry.at < b.entry.at ? 1 : -1))
    .slice(0, 150);
  const html = mine
    .map(({ laneId, entry: e, repoSlug }) => {
      const cls = e.type === "ASK" ? "t-ask" : e.type === "ANSWER" ? "t-answer" : "t-insight";
      const rest =
        e.type === "ASK"
          ? `${kindCode(e.kind ?? "?")} ${askIdLink(e.id, repoSlug, laneId)}`
          : e.type === "ANSWER"
            ? `${kindCode(e.action ?? "?")} on ${askIdLink(e.ask ?? "?", repoSlug, laneId)}`
            : `${kindCode(e.kind)}: ${esc(e.text)}`;
      return `<div class="log-line">${timestampStackHtml(e.at)}<span class="${cls}">${esc(e.type)}</span>&nbsp;&nbsp;<a href="/${esc(repoSlug)}" class="mono" style="color:var(--pink)">${esc(repoSlug)}</a>&nbsp;&nbsp;${laneTagHtml(laneId, repoSlug)}&nbsp;&nbsp;${rest}</div>`;
    })
    .join("");
  return `<div class="log-feed">${html || '<div class="empty">No activity yet.</div>'}</div>`;
}

const OAUTH_PROVIDER_LABELS: Record<Provider, string> = { cloudflare: "Cloudflare", google: "Google", github: "GitHub" };

async function renderOwnProfile(me: Agent, env: WebEnv): Promise<Response> {
  const createdAgents = await listAgentsCreatedBy(env.DB, me.username);
  const allSelf = [me, ...createdAgents];
  const tokenLists = await Promise.all(allSelf.map((a) => listTokensForAgent(env.DB, a.username)));

  const linkedIdentities = await listAgentIdentities(env.DB, me.username);
  const linkedProviders = new Set(linkedIdentities.map((i) => i.provider));
  const lastLoginWarning =
    "This is your only connected login. If you don't have your Guardian ID login secret saved, disconnecting it could lock you out of this account. Disconnect anyway?";
  const linkedLoginsHtml = (Object.keys(OAUTH_PROVIDER_LABELS) as Provider[])
    .map((p) =>
      linkedProviders.has(p)
        ? `<li class="row">${OAUTH_PROVIDER_LABELS[p]} <span class="badge badge-green">connected</span>
            <form method="post" action="/profile/identities/${p}/disconnect" class="inline">
              <button type="submit" class="danger"${linkedProviders.size === 1 ? ` onclick="${esc(`return confirm(${JSON.stringify(lastLoginWarning)})`)}"` : ""}>Disconnect</button>
            </form></li>`
        : `<li class="row">${OAUTH_PROVIDER_LABELS[p]} <a href="/auth/start/${p}?link=true"><button class="secondary">Connect</button></a></li>`,
    )
    .join("");
  // Only offered for an identity zz itself can act on at its own
  // registrar -- a foreign-registrar id or the bare-domain root never
  // gets this row (ownGuardianName's own guard, see its definition).
  const reissueWarning = "This immediately replaces your Guardian ID login secret -- the old one stops working right away. Continue?";
  const ownName = ownGuardianName(me.username);
  const guardianSecretRowHtml = ownName
    ? `<li class="row">Guardian ID login secret
         <form method="post" action="/profile/login-secret/reissue" class="inline">
           <button type="submit" class="secondary" onclick="${esc(`return confirm(${JSON.stringify(reissueWarning)})`)}">Regenerate</button>
         </form></li>`
    : "";
  // The one set of facts about a Guardian ID that are always real,
  // live, publicly resolvable data -- works for any did:guardian
  // identity, local or on a foreign registrar, not just zzmq.dev's own
  // (unlike the login-secret row above, which only makes sense for one
  // zz itself can act on). The rotate button below is gated the same
  // way (ownGuardianName) and for the same reason: only an identity
  // zzmq.dev's own registrar actually custodies has a key here to
  // rotate at all.
  const meGuardianParsed = splitGuardianDid(me.username);
  let guardianIdInfoHtml = "";
  if (meGuardianParsed) {
    const wellKnownPath = `/.well-known/guardian/${meGuardianParsed.name ?? "_"}`;
    const guardians = await currentGuardians(env, meGuardianParsed.name, meGuardianParsed.domain);
    const guardiansHtml = guardians === null ? '<span class="muted">(couldn\'t load)</span>' : guardians.length === 0 ? '<span class="muted">none -- self-sovereign</span>' : guardians.map(formatAgentId).join(", ");
    const rotateWarning = "This rotates your Guardian ID's own operational key. Any bearer token you've already minted keeps working -- this only replaces the key used to sign future did:guardian operations.";
    const rotateButtonHtml = ownGuardianName(me.username)
      ? `<form method="post" action="/profile/key/rotate" class="inline"><button type="submit" class="secondary" onclick="${esc(`return confirm(${JSON.stringify(rotateWarning)})`)}">Rotate key</button></form>`
      : "";
    guardianIdInfoHtml = `<li class="row stack">
        <div>Guardian ID <code>${esc(me.username)}</code> -- <a href="https://${esc(meGuardianParsed.domain)}${wellKnownPath}">DID document</a> ${rotateButtonHtml}</div>
        <div class="muted">Guardians: ${guardiansHtml}</div>
      </li>`;
  }

  // One flat, unified list across you and every agent you manage --
  // no more "your tokens" vs "managed agents' tokens" as two separate
  // sub-UIs (per direct instruction: token management should not
  // distinguish you from the agents you manage).
  const tokenRows = allSelf
    .flatMap((a, i) => tokenLists[i].filter((t) => !t.revoked_at).map((t) => ({ agent: a, token: t })))
    .map(
      ({ agent, token }) =>
        `<li class="row">${formatAgentId(agent.username)} <span class="mono">${esc(token.id)}</span> <span class="muted">${token.last_used_at ? `last used ${esc(token.last_used_at)}` : "never used"}</span>
          <form method="post" action="/profile/tokens/${token.id}/revoke" class="inline"><button type="submit" class="danger">Revoke</button></form></li>`,
    )
    .join("");

  // Every Lane you hold owner/coordinator/viewer/committee on, across
  // every repo -- the real cross-repo index (migration 0018), not a
  // fan-out to each repo's own DO.
  const laneRows = await listLanesForPrincipal(env.DB, me.username);

  const meParsed = splitGuardianDid(me.username);
  const meDisplayName = meParsed ? (meParsed.name ? `${meParsed.name}@${meParsed.domain}` : `@${meParsed.domain}`) : me.username;

  return layout(
    `${meDisplayName} (you)`,
    me,
    `${agentNameRecordHtml(me)}
     ${card(
       "Credentials",
       `<p class="hint">You, and every agent you manage, share one token list -- not "yours" vs "theirs" in any authority sense, just one place to issue, rotate, or revoke whatever can authenticate as any of them.</p>
        <ul class="list">${tokenRows || '<li class="empty">No active tokens.</li>'}</ul>`,
       { addModal: "modal-add-token" },
     )}

     ${card(
       "Linked logins",
       `<p class="hint">Connecting a login here binds it to your existing zzmq.dev id -- it never creates a separate one.</p>
        <ul class="list">${linkedLoginsHtml}${guardianSecretRowHtml}${guardianIdInfoHtml}</ul>`,
     )}

     ${card(
       "Lanes",
       `<ul class="list">${
         shardGroupedListHtml(
           laneRows,
           ({ lane }) => laneKey(lane),
           ({ lane }) => laneOriginKey(lane),
           ({ lane, role }) => `<a href="/${esc(lane.repo_slug)}#lane-${esc(lane.lane_id)}" class="mono" style="color:var(--pink)">${esc(lane.name)}</a>${roleBadge(role)}`,
           "related Lane",
         ) || '<li class="empty">None yet.</li>'
       }</ul>`,
       { addModal: "modal-create-repo" },
     )}

     ${card(
       "Activity",
       await agentActivityHtml(
         me,
         (await Promise.all([...new Set(laneRows.map((r) => r.lane.repo_slug))].map((slug) => getRepoBySlug(env.DB, slug)))).filter((r): r is RepoRow => r !== null),
         env,
       ),
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
       <h3>Start a new Lane</h3>
       <form id="create-repo-form" class="stack">
         <input name="name" placeholder="lane-name" required pattern="[A-Za-z0-9._-]+">
         <input name="description" placeholder="description">
         <select name="license">
           <option value="">No license</option>
           ${LICENSE_ORDER.map((k) => `<option value="${esc(k)}">${esc(LICENSES[k].name)}</option>`).join("")}
         </select>
         <p class="hint" data-create-repo-progress hidden>Creating your Lane -- this takes a few seconds (real git history plus its own Ladder and origin Lane get set up for real, not simulated).</p>
         <p class="hint" style="color:var(--pico-del-color,#c33)" data-create-repo-error hidden></p>
         <div class="modal-actions">
           <button type="button" class="secondary" onclick="this.closest('dialog').close()">Cancel</button>
           <button type="submit">Create</button>
         </div>
       </form>
     </div></dialog>`,
    { h1Html: `${esc(meDisplayName)} (you) <span class="hint" style="font-size:.55em;font-weight:400">(${esc(me.username)})</span>` },
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
         <p>Token for ${formatAgentId(agent.username)} -- copy it now, it won't be shown again:</p>
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

/** The reverse of the "Linked logins" card's own Connect button -- only ever acts on the caller's own identities, never anyone else's (no username/target param at all, just whichever provider on your own profile). */
async function handleDisconnectProvider(provider: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  if (provider === "cloudflare" || provider === "google" || provider === "github") {
    await deleteAgentIdentity(env.DB, me.username, provider);
  }
  return redirect(`/${me.username}`);
}

async function handleRbacGrantForm(repoSlug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const form = await request.formData();
  try {
    await doRbacGrant(env, me, repoSlug, String(form.get("principal") ?? ""), String(form.get("role") ?? "viewer") as RbacRole);
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

async function handleCleanupShardsForm(repoSlug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  let result: ShardCleanupResult;
  try {
    result = await doCleanupShards(env, me, repoSlug);
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.message, { status: err.status });
    throw err;
  }
  // Surfaced as plain text instead of the usual clean redirect --
  // a partial failure silently redirecting as if it fully succeeded
  // is exactly what made the underlying bug this fixes so confusing
  // to notice in the first place. Whatever's left can be retried by
  // clicking the button again.
  if (result.failed.length > 0) {
    const lines = result.failed.map((f) => `  ${f.slug}: ${f.error}`).join("\n");
    return new Response(`Deleted ${result.deleted} related Lane(s), but ${result.failed.length} failed and are still there -- try again:\n\n${lines}`, { status: 207, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return redirect(`/${repoSlug}/settings`);
}

/** Track/untrack a repo -- any logged-in agent, no RBAC check at all (not a grant, just a personal bookmark -- see migration 0011's header). */
async function handleTrackForm(repoSlug: string, tracking: boolean, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const repo = await getRepoBySlug(env.DB, repoSlug);
  if (!repo) return new Response("no such Lane", { status: 404 });
  if (tracking) await trackRepo(env.DB, me.username, repoSlug);
  else await untrackRepo(env.DB, me.username, repoSlug);
  return redirect(`/${repoSlug}`);
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

/** Owned + role-granted + tracked repos, role-sorted -- the same listMyRepos the profile page renders, as JSON. Backs the TUI's "start from your own repos when logged in" (zz top, once it goes past the local/remote plumbing fixed in this pass). */
async function handleApiMyRepos(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const rows = await listMyRepos(env.DB, me.username);
    return json({ repos: rows.map(({ repo, role }) => ({ slug: repo.slug, role })) });
  });
}

/** Same trackRepo/untrackRepo handleTrackForm already calls for the web UI's own button -- a JSON sibling since that one only ever returns an HTML redirect, which the CLI/TUI's Explore "track" action (zz top) needs a real {ok:true}/{error} response from instead. */
async function handleApiTrack(repoSlug: string, tracking: boolean, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const repo = await getRepoBySlug(env.DB, repoSlug);
    if (!repo) throw new ApiError(404, "no such Lane");
    if (tracking) await trackRepo(env.DB, me.username, repoSlug);
    else await untrackRepo(env.DB, me.username, repoSlug);
    return json({ ok: true });
  });
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

/** `zz agent rotate-key <username>` -- see doRotateKey. */
async function handleApiRotateKey(username: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const { agent, document } = await doRotateKey(env, me, username);
    return json({ agent, document });
  });
}

/** `zz work --register [name]` -- see doRegisterManagedIdentity. */
async function handleApiRegisterManagedIdentity(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    const { agent, token, did } = await doRegisterManagedIdentity(env, me, body.name);
    return json({ agent, token, did }, 201);
  });
}

/** `zz work --as <name-or-name@domain>` -- see doResolveManagedIdentity. */
async function handleApiResolveManagedIdentity(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json().catch(() => ({}))) as { identifier?: string };
    if (!body.identifier) throw new ApiError(400, "identifier is required");
    const { agent, token } = await doResolveManagedIdentity(env, me, body.identifier);
    return json({ agent, token });
  });
}

async function handleApiDeleteAgent(username: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    await doDeleteAgent(env, me, username);
    return json({ ok: true });
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

/** #21: an agent choosing its own name, permanently -- self-only (the bearer token's own identity is the target, same as handleApiRevokeSelf, never a creator acting on its behalf) and one-time (setAgentOwnName itself refuses if display_name is already set, the real enforcement; this is just the route). */
async function handleApiSetOwnName(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { display_name?: string };
    const displayName = body.display_name?.trim();
    if (!displayName) throw new ApiError(400, "display_name is required");
    try {
      const agent = await setAgentOwnName(env.DB, me.username, displayName);
      return json(agent);
    } catch (err) {
      throw new ApiError(409, err instanceof Error ? err.message : String(err));
    }
  });
}

async function handleApiCreateRepo(request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { name?: string; description?: string; owner_username?: string; license?: string; from?: string; origin?: string };
    const owner = !body.owner_username || body.owner_username === me.username ? me : await getAgent(env.DB, body.owner_username);
    if (!owner || (owner.username !== me.username && owner.created_by !== me.username)) throw new ApiError(403, "not yours to create repos as");
    const name = (body.name ?? "").trim();
    const description = body.description?.trim() || null;
    if (body.from) {
      // #59: zz lane create <name> --from <owner/lane> -- forks an
      // existing Lane's own repo into a new, explicitly-named one
      // instead of starting from scratch. `origin` defaults to the
      // --from Lane's own origin Lane; an explicit --origin overrides
      // which existing Lane the new one is recorded as originating
      // from (still always that OTHER Lane's own origin Lane, not an
      // arbitrary non-origin one -- the lower-level lane_propose tool
      // call is still there for that finer-grained case).
      const fromCtx = await getRepoAccessContext(body.from, env);
      if (!fromCtx) throw new ApiError(404, `no such Lane "${body.from}"`);
      // A real, missed-until-now gap this surfaced: unlike ensureShard
      // (only ever reachable by actually claiming a real Ask, which
      // already implies some access), this is a direct, standalone
      // command -- forking a private Lane you can't even read would
      // bypass its own visibility entirely without this check.
      if (!(await canReadRepo(request, env, fromCtx.meta, fromCtx.lane))) throw new ApiError(403, `not yours to fork from: "${body.from}"`);
      const fromRow = fromCtx.repoRow;
      const originSlug = body.origin || body.from;
      const originRow = originSlug === body.from ? fromRow : await getRepoBySlug(env.DB, originSlug);
      if (!originRow) throw new ApiError(404, `no such Lane "${originSlug}"`);
      const repo = await doForkRepo(env, fromRow, owner, name, description, { repo: originRow.artifacts_name, lane: ORIGIN_LANE_ID });
      return json(repo, 201);
    }
    if (body.origin) throw new ApiError(400, "--origin needs --from to attach to");
    const repo = await doCreateRepo(env, owner, name, description, body.license ?? null);
    return json(repo, 201);
  });
}

async function handleApiListRepos(request: Request, env: WebEnv): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const viewer = await resolveRequestAgent(request, env);
  const repos = q ? await searchRepos(env.DB, q, 50, viewer?.username ?? null) : await listRecentRepos(env.DB, 50, viewer?.username ?? null);
  return json({ repos });
}

// #43: backs zz lane submit's own lane_id -> owner/name lookup, so its
// redundant owner/name argument becomes optional. Never silently picks
// a slug when more than one repo happens to share this lane_id (e.g.
// "origin", or a hand-picked --id colliding across two repos) -- the
// caller falls back to asking for the explicit slug instead.
async function handleApiLaneLookup(laneId: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const viewer = await resolveRequestAgent(request, env);
    const slugs = await findReposByLaneId(env.DB, laneId, viewer?.username ?? null);
    if (slugs.length === 0) throw new ApiError(404, `no Lane with id "${laneId}" found (or you don't have access to it)`);
    if (slugs.length > 1) throw new ApiError(409, `"${laneId}" exists in more than one Lane (${slugs.join(", ")}) -- give the owner/name explicitly`);
    return json({ repo_slug: slugs[0] });
  });
}

async function handleApiGetRepo(slug: string, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const ctx = await getRepoAccessContext(slug, env);
    if (!ctx) throw new ApiError(404, "no such Lane");
    return json({ repo: ctx.repoRow, meta: ctx.meta, lane: ctx.lane });
  });
}

/** Token-authenticated sibling of handleDeleteRepoForm's own session-cookie flow (the repo settings page's delete button) -- same doDeleteRepo, same Owner check and orphan-row fallback, just reachable from the CLI (`zz repo delete`) instead of only a browser session. */
async function handleApiDeleteRepo(slug: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    await doDeleteRepo(env, me, slug);
    return json({ ok: true });
  });
}

/** `zz ladder push`'s own mark-ingesting/mark-ready calls, bracketing a bulk import or (later) an incremental sync run -- see accountsDb.ts's RepoRow.ingest_status for what this gates. A plain owner_username check, not the Artifacts-roles round trip doDeleteRepo makes for a real delete -- this is reversible and low-stakes (worst case, a repo shows up in search a little early or a little late), so the D1 row's own recorded owner is authority enough. */
async function handleApiSetIngestStatus(slug: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const repo = await getRepoBySlug(env.DB, slug);
    if (!repo) throw new ApiError(404, "no such Lane");
    if (repo.owner_username !== me.username) throw new ApiError(403, `${me.username} is not the owner of ${slug}`);
    const body = (await request.json()) as { status?: string };
    if (body.status !== "ready" && body.status !== "ingesting") throw new ApiError(400, 'status must be "ready" or "ingesting"');
    await setIngestStatus(env.DB, slug, body.status);
    return json({ ok: true });
  });
}

async function handleApiGetAsks(slug: string, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const ctx = await getRepoAccessContext(slug, env);
    if (!ctx) throw new ApiError(404, "no such Lane");
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
// rules (coordinators/committee/ASK_SCOPE) server-side, the same as
// it does called from the web app or MaintainerDO's existing routes.
// The one thing checked here: args.actor/args.from, when present,
// must equal the authenticated caller's own username -- otherwise a
// valid token for Agent A could act as Agent B just by naming it in
// the payload, which no tool-level check catches (they trust the
// caller-supplied actor/from field completely, same as the local CLI
// always has).
//
// ANON_READ_TOOLS: the tools zz top's own views call (lane_list,
// ladder_tree, repo_info) are allowed with no auth at all, for a public
// repo -- matching a real, already-existing capability, not a new one:
// the web repo page itself (handleRepoPage's getLadderTree/getRootLane)
// already shows this exact content to anonymous visitors by calling
// stub.callTool() directly, outside this JSON layer entirely. Without
// this, zz top's "remote, not logged in" mode (the whole point of
// Explore's anonymous search -- see top.ts's own header) could track
// a public repo but never actually see it: every lane_list/ladder_tree
// poll came back 401 and was silently swallowed by useLaneSnapshots/
// useLadderTrees's own "not reachable yet" catch, which looked
// indistinguishable from "nothing to show" -- confirmed live. Nothing
// else changes: a private repo still requires a real, granted Role
// (not just "logged in as somebody," see the private-repo check
// below), and commit_changeset/ladder_write_rung still require
// Coordinator+ regardless of visibility (COORDINATOR_ONLY_REMOTE_TOOLS,
// below) -- both enforced here now, not just by the CLI's own choice
// of which tools to hand a model.
// policy_show added for the same reason, found while testing #42: the
// web repo page's own Policy panel already shows this to anonymous
// visitors on a public repo (handleRepoPage's policyPanelHtml) -- this
// JSON layer disagreeing with that, requiring auth for the exact same
// content the web UI shows for free, was the inconsistency, not a
// deliberate restriction (policy_show's own tool description already
// says "Unrestricted read -- Policy is meant to be visible... not just
// enforced").
const ANON_READ_TOOLS = new Set(["lane_list", "ladder_tree", "repo_info", "policy_show"]);

// These two write committed content directly, with no further
// per-call authority check of their own the way claim/answer have
// (engine/lane.ts's answer() already checks lane.coordinators/
// committee at the protocol level) -- held here to the same
// Coordinator-or-above bar canPushRepo already holds a raw git push to,
// since a direct commit_changeset bypasses the per-changeset review a
// push would otherwise go through. Previously enforced only by zz
// work's own choice of which tools to hand the model
// (COORDINATOR_ONLY_TOOLS, agent/tools.ts) -- a direct API call
// bypassed that entirely.
const COORDINATOR_ONLY_REMOTE_TOOLS = new Set(["commit_changeset", "ladder_write_rung"]);

const TERMINAL_LANE_STATUSES = new Set(["merged", "closed", "vetoed", "stopped"]);

/**
 * #39's real enforcement point: fires after every `ask_answer` on a
 * shard repo (never on an ordinary, non-shard repo -- an origin
 * repo's own retention is never policy-disposed). Reads the just-
 * answered Lane back (cheap -- one more DO call, same cost any other
 * post-answer read already has), and if it just reached a terminal
 * status (#38) for the first time this call, checks the PARENT
 * repo's own Policy (retention is set on the repo a shard belongs
 * to, not on the shard itself -- a shard never gets its own distinct
 * Policy document worth maintaining) and deletes this shard outright
 * if it says "dispose". Best-effort and silent on any failure --
 * never lets a retention side effect fail the `ask_answer` call that
 * triggered it; a shard that fails to delete here is still cleaned up
 * the next time its parent itself is deleted (doCleanupShards) or
 * can be removed by hand.
 */
async function maybeDisposeShardAfterAnswer(env: WebEnv, shardRepo: RepoRow, laneId: string): Promise<void> {
  try {
    const stub = doStub(env, shardRepo.artifacts_name);
    await stub.configure(shardRepo.artifacts_name);
    const lane = (await stub.callTool("lane_get", { repo: shardRepo.artifacts_name, lane_id: laneId })) as Lane | null;
    if (!lane || !TERMINAL_LANE_STATUSES.has(lane.status)) return;

    const parentSlug = shardRepo.shard_of_slug;
    if (!parentSlug) return;
    const parentRepo = await getRepoBySlug(env.DB, parentSlug);
    if (!parentRepo) return;
    const parentStub = doStub(env, parentRepo.artifacts_name);
    await parentStub.configure(parentRepo.artifacts_name);
    const policy = (await parentStub.callTool("policy_show", { repo: parentRepo.artifacts_name })) as RepoPolicy;
    if (policy.retention.mode !== "dispose") return;

    await env.ARTIFACTS.delete(shardRepo.artifacts_name);
    await deleteRepoRow(env.DB, shardRepo.slug, shardRepo.artifacts_name);
  } catch {
    // Best-effort, see this function's own doc comment.
  }
}

async function handleApiCallTool(slug: string, toolName: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const repo = await getRepoBySlug(env.DB, slug);
    if (!repo) throw new ApiError(404, "no such Lane");
    const canAnonRead = repo.visibility === "public" && ANON_READ_TOOLS.has(toolName);
    const me = canAnonRead ? await resolveRequestAgent(request, env) : await requireApiAgent(request, env);

    // Private repo: being logged in as *somebody* was never the real
    // bar -- canReadRepo already holds every other read surface (the
    // web repo page, git clone/fetch) to "has an actual Role grant,"
    // and this JSON tool-call layer was the one place that fact didn't
    // apply, letting any authenticated account read a private repo's
    // Lane/Ladder/file content (or call a write tool on it) through
    // here regardless of Role.
    if (repo.visibility === "private") {
      const role = me ? await getRepoRoleForPrincipal(env.DB, repo.slug, me.username) : null;
      if (!role) throw new ApiError(403, `${me?.username ?? "anonymous"} has no Role on private repo ${slug}`);
    }
    if (COORDINATOR_ONLY_REMOTE_TOOLS.has(toolName)) {
      const role = me ? await getRepoRoleForPrincipal(env.DB, repo.slug, me.username) : null;
      if (!role || !repoAtLeast(role as RbacRole, "coordinator")) {
        throw new ApiError(403, `${me?.username ?? "anonymous"} is not a Coordinator of ${slug} -- "${toolName}" requires at least Coordinator`);
      }
    }
    // policy_set is the UNGATED write path -- an Owner may always call
    // it (the designed escape hatch), and anyone Coordinator+ may when
    // Policy's own "policy_change" rule says "direct". Anything stricter
    // (self_review/other_approver/vote_quorum/vote_expiring) refuses
    // this tool outright: changing Policy then has to go through the
    // same Ask/Vote protocol a real changeset already does (post a
    // changeset_review or vote_request with payload { decisionKind:
    // "policy", proposal }; engine/lane.ts applies it on grant/tally).
    if (toolName === "policy_set") {
      const role = me ? await getRepoRoleForPrincipal(env.DB, repo.slug, me.username) : null;
      if (!role || !repoAtLeast(role as RbacRole, "coordinator")) {
        throw new ApiError(403, `${me?.username ?? "anonymous"} is not a Coordinator of ${slug} -- "policy_set" requires at least Coordinator`);
      }
      if (role !== "owner") {
        const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(repo.artifacts_name));
        await stub.configure(repo.artifacts_name);
        const policy = (await stub.callTool("policy_show", { repo: repo.artifacts_name })) as RepoPolicy;
        if (policy.policy_change.mode !== "direct") {
          throw new ApiError(
            403,
            `${me?.username}'s Role (${role}) isn't Owner, and ${slug}'s Policy itself requires "${policy.policy_change.mode}" to change -- post an Ask instead (changeset_review for self_review/other_approver, vote_request for vote_quorum/vote_expiring) with payload {decisionKind:"policy", proposal:{...}}; it applies automatically once granted or tallied.`,
          );
        }
      }
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    for (const field of ["actor", "from"]) {
      if (field in body && me && body[field] !== me.username) throw new ApiError(403, `${field} must be your own username (${me.username}) -- a token only acts as the agent it belongs to`);
    }
    const stub = env.MAINTAINER_DO.get(env.MAINTAINER_DO.idFromName(repo.artifacts_name));
    await stub.configure(repo.artifacts_name);
    try {
      let result: unknown;
      try {
        result = await stub.callTool(toolName, { ...body, repo: repo.artifacts_name });
      } catch (err) {
        // A brand-new repo has no origin Lane yet -- doCreateRepo never
        // bootstraps one (demo/greenfield.ts's local flow always did;
        // the remote side only ever caught up for the one dedicated
        // /api/repos/:owner/:repo/ask REST route, doPostAsk, which both
        // the web app's own ask form and the now-retired `zz repo ask`
        // CLI command went through -- #43 retired the CLI-side
        // duplicate in favor of one generic `ask_post`, which needs this
        // same self-heal to not regress on a repo that's never had an
        // Ask posted to it any other way). Bootstrap and retry exactly
        // once, the same lazy-create doPostAsk already did, rather than
        // leaving this gap now that it's the only remaining path in.
        if (toolName === "ask_post" && body.lane_id === ORIGIN_LANE_ID && err instanceof Error && /no such lane: /.test(err.message)) {
          await stub.callTool("lane_propose", { repo: repo.artifacts_name, id: ORIGIN_LANE_ID, name: repo.slug, objective: `the ${repo.slug} repository`, scope: ["**"], actor: repo.owner_username, owners: [repo.owner_username] });
          result = await stub.callTool(toolName, { ...body, repo: repo.artifacts_name });
        } else {
          throw err;
        }
      }
      if (toolName === "ask_answer" && repo.shard_of_slug && typeof body.lane_id === "string") {
        await maybeDisposeShardAfterAnswer(env, repo, body.lane_id);
      }
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
    // A real, pre-existing gap found while working #42, not introduced
    // by it: this endpoint had no access check at all -- any
    // authenticated agent could fork anyone else's private repo,
    // bypassing its own visibility entirely. In practice this is only
    // ever called right after actually claiming a real Ask (ask-
    // claim.ts), which already implies some access to this same repo
    // -- but the endpoint itself shouldn't rely on that being the only
    // caller that ever exists.
    const ctx = await getRepoAccessContext(slug, env);
    if (!ctx) throw new ApiError(404, "no such Lane");
    if (!(await canReadRepo(request, env, ctx.meta, ctx.lane))) throw new ApiError(403, "not yours to fork from");
    const row = await ensureShard(env, slug, me, body.task.trim());
    return json(row, 201);
  });
}

async function handleApiPostAsk(slug: string, request: Request, env: WebEnv): Promise<Response> {
  return withApi(async () => {
    const me = await requireApiAgent(request, env);
    const body = (await request.json()) as { description?: string; decompose?: boolean; lane_id?: string };
    if (!body.description) throw new ApiError(400, "description is required");
    await doPostAsk(env, me, slug, body.description, body.decompose, body.lane_id);
    return json({ ok: true });
  });
}

// --- Explore (list + search, one route) ---

async function handleApiExploreSearch(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return json({ lanes: [], agents: [], ladderHits: [] });
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

function repoRowHtml(r: RepoRow): string {
  // Only ever reached here for your own repo (everyone else's ingesting
  // repos are already filtered out of every listing this renders into --
  // see accountsDb.ts's INGEST_VISIBLE_CLAUSE and renderPublicProfile's
  // own filter), so this is purely "here's one of mine still importing",
  // not a leak of someone else's in-progress state.
  const ingestBadge = r.ingest_status === "ingesting" ? ` <span class="badge badge-yellow">⏳ ingesting</span>` : "";
  return `<span class="badge badge-pink">REPO</span> <a href="/${esc(r.slug)}" class="name mono">${esc(r.slug)}</a>${ingestBadge}${r.description ? ` <span class="desc muted">${autolinkText(r.description)}</span>` : ""}`;
}

function repoResultHtml(r: RepoRow): string {
  return `<li class="row">${repoRowHtml(r)}</li>`;
}

/** A Lane's own row -- links to its own standalone page (#62). */
function laneRowHtml(l: LaneRow): string {
  return `<span class="badge badge-pink">LANE</span> <a href="${laneUrl(l.repo_slug, l.lane_id)}" class="name mono">${esc(l.name)}</a> <span class="badge">${esc(l.status)}</span>${l.objective ? ` <span class="desc muted">${autolinkText(l.objective)}</span>` : ""}`;
}

const laneKey = (l: LaneRow): string => `${l.repo_slug}/${l.lane_id}`;
const laneOriginKey = (l: LaneRow): string | null => (l.origin_repo_slug && l.origin_lane_id ? `${l.origin_repo_slug}/${l.origin_lane_id}` : null);

interface ShardNode<T> {
  item: T;
  children: ShardNode<T>[];
}

/** Groups a flat row list into a parent -> shard tree by walking shard_of_slug pointers (a shard's parent can itself be a shard, so this nests arbitrarily deep). A row whose parent isn't in this same list -- the viewer can't see it, or it's just not part of this particular listing -- is treated as top-level, since there's nothing here to nest it under. */
function groupByShard<T>(rows: T[], slugOf: (t: T) => string, parentSlugOf: (t: T) => string | null): ShardNode<T>[] {
  const slugs = new Set(rows.map(slugOf));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const r of rows) {
    const parent = parentSlugOf(r);
    if (parent && slugs.has(parent)) {
      const list = childrenOf.get(parent) ?? [];
      list.push(r);
      childrenOf.set(parent, list);
    } else {
      roots.push(r);
    }
  }
  const build = (item: T): ShardNode<T> => ({ item, children: (childrenOf.get(slugOf(item)) ?? []).map(build) });
  return roots.map(build);
}

/** A repo listing with shard repos nested -- collapsed by default -- under the repo they were forked from, instead of sitting flat alongside it. Shared by both profile pages and Explore's repo results, since a shard is exactly as real a repo as its parent in either listing, just one that belongs grouped rather than browsed as a peer. */
/** `childLabel` names whatever's nested underneath a parent in the <summary> text -- "shard" for a repo's own shards, "related Lane" for a Lane's non-origin children (see laneGroupedListHtml) -- the tree-building (groupByShard) and row-rendering are otherwise identical for both. */
function shardGroupedListHtml<T>(rows: T[], slugOf: (t: T) => string, parentSlugOf: (t: T) => string | null, renderRow: (t: T) => string, childLabel: string = "shard"): string {
  const render = (nodes: ShardNode<T>[]): string =>
    nodes
      .map((n) => {
        const nested = n.children.length
          ? `<details class="shard-group"><summary>${n.children.length} ${esc(childLabel)}${n.children.length === 1 ? "" : "s"}</summary><ul class="list">${render(n.children)}</ul></details>`
          : "";
        return `<li class="stack"><div class="row">${renderRow(n.item)}</div>${nested}</li>`;
      })
      .join("");
  return render(groupByShard(rows, slugOf, parentSlugOf));
}

/** Every descendant shard of `rootSlug`, at any depth, as one flat list (not including rootSlug itself) -- feeds shardGroupedListHtml for the repo page's own "Shards" panel, same as the already-flat listReposOwnedBy/searchExplore results feed it for profile pages and Explore. */
async function listShardTreeFlat(env: WebEnv, rootSlug: string): Promise<RepoRow[]> {
  const direct = await listShardsOf(env.DB, rootSlug);
  const deeper = await Promise.all(direct.map((s) => listShardTreeFlat(env, s.slug)));
  return [...direct, ...deeper.flat()];
}

/** #62: every descendant Lane of (rootRepoSlug, rootLaneId), at any depth, as one flat list (not including the root itself) -- the Lane-level generalization of listShardTreeFlat above, walking lanes.origin_repo_slug/origin_lane_id instead of repos.shard_of_slug, so it covers both a same-repo child Lane and a cross-repo forked one identically (both set this same pointer, see doForkRepo/ensureShard's own lane_propose call). Feeds a Lane's own standalone page's "Lanes" sub-tab (the rollup). */
async function listLaneDescendantsFlat(env: WebEnv, rootRepoSlug: string, rootLaneId: string): Promise<LaneRow[]> {
  const direct = await listLanesByOrigin(env.DB, rootRepoSlug, rootLaneId);
  const deeper = await Promise.all(direct.map((l) => listLaneDescendantsFlat(env, l.repo_slug, l.lane_id)));
  return [...direct, ...deeper.flat()];
}

function agentResultHtml(a: Agent): string {
  return `<li class="row"><span class="badge badge-cyan">USER</span> ${formatAgentId(a.username)}${a.display_name && a.display_name !== a.username ? ` <span class="desc muted">${esc(a.display_name)}</span>` : ""}</li>`;
}

// A Ladder hit is a fundamentally different shape than a repo/user
// match: it's not "here's a thing", it's "here's something SAID about
// a specific file, anchored to a specific commit" -- so it gets both
// links (file content as it is now, and the commit that summary is
// actually anchored to), not just one link like the other two types.
function ladderResultHtml(h: LadderSearchHit): string {
  const fileLink = `<a href="/${esc(h.repo_slug)}/blob/${esc(h.commit_sha || "HEAD")}/${esc(h.path)}" class="mono">${esc(h.path)}</a>`;
  const commitLink = h.commit_sha ? ` -- <a href="/${esc(h.repo_slug)}/commit/${esc(h.commit_sha)}" class="mono">${esc(h.commit_sha.slice(0, 8))}</a>` : "";
  return `<li class="row"><span class="badge badge-yellow">LADDER</span> <span class="desc">${esc(h.summary)}</span><br><span class="muted">in <a href="/${esc(h.repo_slug)}">${esc(h.repo_slug)}</a>: ${fileLink}${commitLink}</span></li>`;
}

async function handleExplore(request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  let bodyHtml: string;
  if (!q) {
    // No query: the MRU Lane browse list, unchanged -- heterogeneous
    // results are a SEARCH behavior, not something to force onto
    // plain browsing where "recently active Lanes" is the actually
    // useful default view.
    const lanes = await listRecentLanes(env.DB, 50, me?.username ?? null);
    bodyHtml = `<ul class="list">${shardGroupedListHtml(lanes, laneKey, laneOriginKey, laneRowHtml, "related Lane") || '<li class="empty">No Lanes yet.</li>'}</ul>`;
  } else {
    const { lanes, agents, ladderHits } = await searchExplore(env.DB, q, 25, me?.username ?? null);
    const rows = [shardGroupedListHtml(lanes, laneKey, laneOriginKey, laneRowHtml, "related Lane"), ...agents.map(agentResultHtml), ...ladderHits.map(ladderResultHtml)];
    bodyHtml = `<ul class="list">${rows.join("") || '<li class="empty">No matches.</li>'}</ul>`;
  }

  return layout(
    "Explore",
    me,
    `<div class="ac-wrap" style="margin-bottom:1.25rem">
       <form method="get" action="/explore" class="field-row">
         <input name="q" value="${esc(q)}" placeholder="search Lanes, users, and the Ladder" autocomplete="off" data-explore-search="explore-ac-box" style="flex:3">
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

/** log/readTree/readFile all resolve a branch, tag, or commit sha directly as `ref` -- but not the literal "HEAD", which a caller might reasonably construct when there's no specific commit to point at (the ladder-search autocomplete below does exactly this, having no sha of its own to use). Normalizes that one case to the repo's real default branch name; anything else passes through untouched. */
async function resolveRefName(repo: ArtifactsRepo, ref: string): Promise<string> {
  if (ref !== "HEAD") return ref;
  const info = await repo.info();
  return info.defaultBranch;
}

/** repo.readTree only ever returns one level -- this walks one path segment at a time to list a subdirectory's own entries, returning null if any segment along the way is missing or isn't itself a directory. `path` of "" returns `rootEntries` unchanged (the repo root itself needs no walk). */
async function readTreeAtPath(repo: ArtifactsRepo, rootEntries: TreeEntry[], path: string): Promise<TreeEntry[] | null> {
  if (!path) return rootEntries;
  let entries = rootEntries;
  for (const segment of path.split("/")) {
    const entry = entries.find((e) => e.name === segment);
    if (!entry || entry.type !== "tree") return null;
    entries = (await repo.readTree(entry.hash)) ?? [];
  }
  return entries;
}

/** Shared by handleRepoPage's "Files" tab, handleCommit's tree, and handleTree below, so a directory link added to one always matches the others' own route. `ref` is whatever the caller is already browsing at -- a real commit sha (handleCommit's own tree, pinned to that commit) or the default branch name (handleRepoPage's "Files" tab, i.e. HEAD) -- carried into both the file and directory links so clicking through stays pinned to the same point in history rather than silently jumping to HEAD. Previously a directory rendered as a plain unlinked <span>; that's the "can't navigate into a directory" gap this fixes. */
function fileListRowsHtml(slug: string, ref: string, basePath: string, entries: TreeEntry[], summaryFor?: (name: string) => string | undefined): string {
  return entries
    .map((e) => {
      const fullPath = basePath ? `${basePath}/${e.name}` : e.name;
      const href = e.type === "tree" ? `/${esc(slug)}/tree/${esc(ref)}/${esc(fullPath)}` : `/${esc(slug)}/blob/${esc(ref)}/${esc(fullPath)}`;
      const label = `<a href="${href}" class="mono">${esc(e.name)}</a>`;
      const summary = summaryFor?.(e.name);
      return summary ? `<li class="stack"><div class="row">${e.type === "tree" ? "📁" : "📄"} ${label}</div>${summaryDetailHtml(summary)}</li>` : `<li class="row">${e.type === "tree" ? "📁" : "📄"} ${label}</li>`;
    })
    .join("");
}

/** The repo-name link plus one clickable crumb per path segment, each pointing at that ancestor directory's own /tree/<ref>/<path> -- shared by handleTree (every segment, including the last, links to itself -- harmless, and keeps the breadcrumb's own build simpler) and handleBlob (the last segment is the file name, not a directory, so it renders as plain text instead). */
function pathBreadcrumbHtml(slug: string, ref: string, path: string, lastIsLink: boolean): string {
  const segments = path.split("/").filter(Boolean);
  const crumbs = [`<a href="/${esc(slug)}">${esc(slug)}</a>`];
  let acc = "";
  segments.forEach((seg, i) => {
    acc = acc ? `${acc}/${seg}` : seg;
    const isLast = i === segments.length - 1;
    crumbs.push(isLast && !lastIsLink ? `<span class="mono">${esc(seg)}</span>` : `<a href="/${esc(slug)}/tree/${esc(ref)}/${esc(acc)}" class="mono">${esc(seg)}</a>`);
  });
  return crumbs.join(" / ");
}

/** The "Files" tab's own tree, one directory deeper -- GitHub's /tree/<path> equivalent, always at HEAD (no ref segment in the path, same convention handleBlob already uses). */
/** `ref` is a branch name, tag, or commit sha -- repo.log/readTree/readFile all resolve any of the three directly, so a tree reached from a historical commit's own page stays pinned to that commit rather than jumping to HEAD, and the ref lives in the URL path (not a query param) so the page itself is the permalink. */
async function handleTree(slug: string, ref: string, path: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("no such Lane", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.lane))) return new Response("no such Lane", { status: 404 });
  const me = await resolveRequestAgent(request, env);

  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  ref = await resolveRefName(repo, ref);
  const [head] = await repo.log({ ref, limit: 1 });
  if (!head) return new Response("no such ref", { status: 404 });
  const rootEntries: TreeEntry[] = (await repo.readTree(head.treeHash)) ?? [];
  const entries = await readTreeAtPath(repo, rootEntries, path);
  if (!entries) return new Response("no such directory", { status: 404 });

  return layout(
    path || slug,
    me,
    `<div class="card">
      <h2>${pathBreadcrumbHtml(slug, ref, path, true)}</h2>
      <p class="muted">at <a href="/${esc(slug)}/commit/${esc(head.hash)}" class="mono">${esc(head.hash.slice(0, 8))}</a></p>
      <ul class="list">${fileListRowsHtml(slug, ref, path, entries) || '<li class="empty">Empty directory.</li>'}</ul>
    </div>`,
    { titleHtml: ` \xb7 <a href="/${esc(slug)}">${esc(slug)}</a>` },
  );
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
async function getRepoAccessContext(slug: string, env: WebEnv): Promise<{ repoRow: RepoRow; meta: Awaited<ReturnType<typeof readRepoMeta>>; lane: Lane } | null> {
  const repoRow = await getRepoBySlug(env.DB, slug);
  if (!repoRow) return null;
  try {
    using repo = await env.ARTIFACTS.get(repoRow.artifacts_name);
    const token = await repo.createToken("read", 300);
    const info = await repo.info();
    let { meta, roles } = await readRepoMetaAndRoles(info.remote, token);
    if (!meta) {
      await ensureMeta(info.remote, token, { description: repoRow.description ?? "", owner: repoRow.owner_username });
      ({ meta, roles } = await readRepoMetaAndRoles(info.remote, token));
    }
    // #41: repo-level RBAC reads the origin Lane's own owners/
    // coordinators/viewers now, not roles.json directly -- `roles` is
    // only still read above to feed ensureOriginLaneRoles's one-time
    // migration fallback for a repo that hasn't been touched since.
    const lane = await ensureOriginLaneRoles(env, repoRow, roles);
    return { repoRow, meta, lane };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // A real, confirmed-live failure mode: a D1 repos row surviving
    // its own backing Artifacts repo's deletion (doDeleteRepo's own
    // comment on exactly this already calls it "an orphaned D1 row
    // from some earlier delete that cleared the Artifacts repo but
    // failed before this row" -- same tolerance applied here, not
    // just there). Before this, visiting such a Lane's page threw a
    // raw, unhandled ArtifactsError all the way to the top-level fetch
    // handler (a bare 500 "Worker threw exception", confirmed live)
    // instead of the same clean 404 every other "no such Lane" path
    // already gives. Treated as "doesn't really exist" here, same as
    // repoRow itself being missing above -- not re-thrown.
    return null;
  }
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

/**
 * A real, previously-undiscovered bug found live while verifying #67's
 * test push: `zz credential-helper`'s own output (and the
 * x-token-auth-over-Basic convention it follows, same as GitHub's
 * personal-access-token-over-HTTPS) always sends username="x-token-
 * auth" (a fixed placeholder, never empty) with the real token in
 * password -- so `basic.username || basic.password` picked the
 * placeholder every single time, never the actual token, and every
 * git push authenticated this way failed closed (hashed "x-token-
 * auth" itself, which naturally never matches a real row) --
 * confirmed directly against D1: the real token's hash WAS an active,
 * unrevoked row, just never the string this function hashed. Prefers
 * password now (where the real token lives under that convention),
 * falling back to username only for the other common convention
 * (`https://<token>@host/...`, token as username, password empty).
 */
async function resolveGitAuthPrincipal(request: Request, env: WebEnv): Promise<string | null> {
  const basic = parseBasicAuth(request);
  if (!basic) return null;
  const candidate = basic.password || basic.username;
  if (!candidate) return null;
  const token = await findActiveAgentToken(env.DB, hashAgentToken(candidate));
  if (!token) return null;
  await touchAgentToken(env.DB, token.id);
  return token.agent_username;
}

// Public repos (the default, and everything created so far): open to
// anyone, same as today. Private repos: a repo needs an explicit
// grant (any role, including "viewer") for the signed-in Agent (web
// session) or the Agent resolved from a Basic Auth / bearer token
// (git CLI, API clients) -- one check, one principal, no "or any of
// my agents" indirection now that every Agent's standing is its own.
async function canReadRepo(request: Request, env: WebEnv, meta: Awaited<ReturnType<typeof readRepoMeta>>, lane: Lane): Promise<boolean> {
  if (meta?.policy.visibility !== "private") return true;
  const me = await resolveRequestAgent(request, env);
  const gitPrincipal = await resolveGitAuthPrincipal(request, env);
  const principals = [me?.username, gitPrincipal].filter((p): p is string => !!p);
  if (principals.length === 0) return false;
  return principals.some((p) => laneHasAnyGrant(lane, p));
}

// Push always requires real, resolved authentication -- never
// anonymous, even on a public repo (same as GitHub: public means
// publicly readable, not publicly writable). Gated at Coordinator or
// above, same bar as granting a changeset_review -- matching
// governance.md's own model (Contributor "needs a Coordinator's grant
// for each changeset"; a raw push bypasses that per-changeset review
// entirely, so it's deliberately held to the same authority that
// could grant the review anyway, not opened to every Contributor).
async function canPushRepo(request: Request, env: WebEnv, lane: Lane): Promise<boolean> {
  const principal = await resolveGitAuthPrincipal(request, env);
  if (!principal) return false;
  return laneHasCoordinatorOrAbove(lane, principal);
}

function needGitAuthResponse(): Response {
  return new Response("authentication required\n", { status: 401, headers: { "www-authenticate": 'Basic realm="zz"' } });
}

// #62: known, fixed git-notes ref namespaces (cloudflareLadderBackend.ts's
// own notesRefFor) -- shown as-is in the Git sub-tab rather than a live
// ref enumeration against Artifacts, which has no confirmed API for
// listing refs/branches beyond what repo.log/readTree already expose
// for the default branch specifically.
const KNOWN_LADDER_NOTES_REFS = ["refs/notes/zz/ladder/code", "refs/notes/zz/ladder/changeset", "refs/notes/zz/ladder/release"];

// #62 follow-up (real-time polling): these six render the exact inner
// markup of each `data-live-panel` wrapper on a Lane page -- shared by
// handleLanePage's own first paint and handleLaneFragment's periodic
// refetch (zzLivePanel, WEB_JS), so a poll's content is always
// identical in shape to what the full page would have rendered for the
// same underlying data, never a second, drifting copy of the same
// markup.
function renderFeedHtml(history: HistoryEntry[], repoSlug: string, laneId: string): string {
  const html = [...history]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 150)
    .map((e) => {
      const cls = e.type === "ASK" ? "t-ask" : e.type === "ANSWER" ? "t-answer" : "t-insight";
      const rest =
        e.type === "ASK"
          ? `${kindCode(e.kind ?? "?")} from ${formatAgentId(e.from ?? "?")} ${askIdLink(e.id, repoSlug, laneId)}`
          : e.type === "ANSWER"
            ? `${kindCode(e.action ?? "?")} by ${formatAgentId(e.from ?? "?")} on ${askIdLink(e.ask ?? "?", repoSlug, laneId)}`
            : `${kindCode(e.kind)} from ${formatAgentId(e.from)}: ${esc(e.text)}`;
      return `<div class="log-line">${timestampStackHtml(e.at)}<span class="${cls}">${esc(e.type)}</span>&nbsp;&nbsp;${rest}</div>`;
    })
    .join("");
  return html || '<div class="empty">No activity yet.</div>';
}

function renderAsksHtml(history: HistoryEntry[]): string {
  const answersByAsk = new Map<string, AnswerEntry[]>();
  for (const entry of history) {
    if (entry.type !== "ANSWER") continue;
    const list = answersByAsk.get(entry.ask) ?? [];
    list.push(entry);
    answersByAsk.set(entry.ask, list);
  }
  const html = history
    .filter((e): e is AskEntry => e.type === "ASK")
    .map((e) => {
      const answersHtml = (answersByAsk.get(e.id) ?? [])
        .map((a) => `<div class="row ask-answer-row">${timestampStackHtml(a.at)}<span class="badge badge-green">ANSWER</span> ${kindCode(a.action)} by ${formatAgentId(a.from)}</div>${jsonBlock(a.payload)}`)
        .join("");
      return `<li class="stack" id="${esc(e.id)}"><div class="row"><span class="badge badge-yellow">ASK</span> ${timestampStackHtml(e.at)}${kindCode(e.kind ?? "?")} from ${formatAgentId(e.from ?? "?")}</div>${jsonBlock(e.payload)}${answersHtml}</li>`;
    })
    .join("");
  return `<ul class="list">${html || '<li class="empty">No Asks posted yet.</li>'}</ul>`;
}

function renderInsightsHtml(history: HistoryEntry[]): string {
  const html = history
    .filter((e): e is InsightEntry => e.type === "INSIGHT")
    .map((e) => `<li class="stack"><div class="row"><span class="badge badge-cyan">INSIGHT</span> ${timestampStackHtml(e.at)}${kindCode(e.kind)} from ${formatAgentId(e.from)}</div>${textBlock(e.text)}</li>`)
    .join("");
  return `<ul class="list">${html || '<li class="empty">No Insights posted yet.</li>'}</ul>`;
}

async function renderLanesRollupHtml(env: WebEnv, repoSlug: string, laneId: string): Promise<string> {
  const descendants = await listLaneDescendantsFlat(env, repoSlug, laneId);
  return `<ul class="list">${shardGroupedListHtml(descendants, laneKey, laneOriginKey, laneRowHtml, "related Lane") || '<li class="empty">No related Lanes yet.</li>'}</ul>`;
}

async function renderGraphHtml(env: WebEnv, repoSlug: string, artifactsName: string, defaultBranch: string): Promise<string> {
  const ladder = await getLadderTree(env, artifactsName);
  return `<ul class="list list-scroll">${ladder ? renderLadderNode(repoSlug, ladder, defaultBranch) : '<li class="empty">No Ladder content yet.</li>'}</ul>`;
}

async function renderCommitsHtml(env: WebEnv, repoSlug: string, artifactsName: string, laneId: string, commitsPage: number): Promise<{ html: string; pagerHtml: string }> {
  const COMMITS_PAGE_SIZE = 30;
  using repo = await env.ARTIFACTS.get(artifactsName);
  const info = await repo.info();
  const commitsFetched = await repo.log({ ref: info.defaultBranch, limit: COMMITS_PAGE_SIZE + 1, offset: (commitsPage - 1) * COMMITS_PAGE_SIZE });
  const hasMoreCommits = commitsFetched.length > COMMITS_PAGE_SIZE;
  const commits = hasMoreCommits ? commitsFetched.slice(0, COMMITS_PAGE_SIZE) : commitsFetched;
  const html = commits
    .map((c) => `<li class="row"><a href="/${esc(repoSlug)}/commit/${esc(c.hash)}" class="mono">${esc(c.hash.slice(0, 8))}</a> ${esc(c.message.split("\n")[0])} <span class="muted">${esc(c.author.name)} ${esc(new Date(c.authoredAt * 1000).toISOString())}</span></li>`)
    .join("");
  // #commits (restored on load by zzInitTabs below) keeps the Commits
  // sub-tab open across a prev/next reload -- without it, a page link
  // would land back on whichever tab renders first, losing your place
  // every single click.
  const pageUrl = laneUrl(repoSlug, laneId);
  const pagerHtml =
    commitsPage > 1 || hasMoreCommits
      ? `<div class="commit-nav">
        ${commitsPage > 1 ? `<a href="${pageUrl}?commitsPage=${commitsPage - 1}#commits" class="mono">&larr; newer</a>` : "<span></span>"}
        ${hasMoreCommits ? `<a href="${pageUrl}?commitsPage=${commitsPage + 1}#commits" class="mono">older &rarr;</a>` : "<span></span>"}
      </div>`
      : "";
  return { html: `<ul class="list">${html || '<li class="empty">No commits yet.</li>'}</ul>`, pagerHtml };
}

/**
 * #62: a Lane's own standalone page -- every Lane gets one now, not
 * just the origin Lane (which still IS this same repo's own top-level
 * URL, laneId defaulting to ORIGIN_LANE_ID; a non-origin lane_id within
 * the SAME repo gets the nested /lane/<id> URL instead, see laneUrl).
 * CODE-tab content (Files/Commits/Git) is always this REPO's own --
 * shared by every same-repo Lane, since there's only one git history to
 * show regardless of which lane_id you're viewing; a forked Lane has
 * its own separate repo/slug entirely, reached by visiting that slug's
 * own page, not a special case here. ACTIVITY/CONTEXT-tab content
 * (Feed/Asks/Insights) is THIS LANE's own history only, never
 * aggregated across its rollup -- the Lanes sub-tab is where the
 * rollup itself lives, as a navigable tree, not inlined activity.
 */
async function handleLanePage(me: Agent | null, repoSlug: string, laneId: string, request: Request, env: WebEnv, origin: string): Promise<Response> {
  const ctx = await getRepoAccessContext(repoSlug, env);
  if (!ctx) return new Response("no such Lane", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.lane))) return new Response("no such Lane", { status: 404 });
  const { repoRow, meta } = ctx;

  // Started here, awaited down below where they're actually used --
  // none of these three depend on anything from the git-content reads
  // that follow (they only need repoRow/artifacts_name, already in
  // hand), so there's no reason the DO/Ladder/D1-rollup round-trips
  // should wait for the Artifacts round-trip to finish first, or vice
  // versa.
  const lanesAndLadder = Promise.all([getAllLanes(env, repoRow.artifacts_name), getLadderTree(env, repoRow.artifacts_name)]);
  const lanesRollupPromise = renderLanesRollupHtml(env, repoSlug, laneId);
  const trackingCheck = me ? isTrackingRepo(env.DB, me.username, repoSlug) : Promise.resolve(false);

  const [allLanes, ladder] = await lanesAndLadder;
  const lane = laneId === ctx.lane.id ? ctx.lane : allLanes.find((l) => l.id === laneId);
  if (!lane) return new Response("no such Lane", { status: 404 });
  const isOriginLane = laneId === ORIGIN_LANE_ID;

  using repo = await env.ARTIFACTS.get(repoRow.artifacts_name);
  const info = await repo.info();
  // Separate from the Commits tab's own paginated fetch below -- once
  // that can be any page, not just the first, commits[0] (this used to
  // reuse that single call's own first result) is no longer
  // necessarily HEAD.
  const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
  const tree: TreeEntry[] = head ? ((await repo.readTree(head.treeHash)) ?? []) : [];
  const readme = head ? await findReadme(repo, tree) : null;

  const commitsPage = Math.max(1, Number(new URL(request.url).searchParams.get("commitsPage")) || 1);
  const { html: commitsHtml, pagerHtml: commitsPagerHtml } = await renderCommitsHtml(env, repoSlug, repoRow.artifacts_name, laneId, commitsPage);

  const fileListHtml = fileListRowsHtml(repoSlug, info.defaultBranch, "", tree);

  // "Actors" (renamed from "Roles"): the origin-tier Role breakdown on
  // the origin Lane's own page (meaningful only there -- an ordinary
  // Lane's own owners/viewers are always empty, see engine/types.ts's
  // Lane.owners doc comment); a non-origin Lane's own coordinators/
  // committee otherwise -- who can actually act on THIS Lane
  // specifically, not the whole repo.
  const actorsHtml = isOriginLane
    ? [
        ...lane.owners.map((p) => `<li class="row">${roleBadge("owner", formatAgentId(p))}</li>`),
        ...lane.coordinators.map((p) => `<li class="row">${roleBadge("coordinator", formatAgentId(p))}</li>`),
        ...lane.viewers.map((p) => `<li class="row">${roleBadge("viewer", formatAgentId(p))}</li>`),
      ].join("")
    : [
        ...lane.coordinators.map((p) => `<li class="row">${roleBadge("coordinator", formatAgentId(p))}</li>`),
        ...lane.committee.filter((p) => !lane.coordinators.includes(p)).map((p) => `<li class="row">${roleBadge("committee", formatAgentId(p))}</li>`),
      ].join("");
  const visibility = meta?.policy.visibility ?? "public";
  const isOwner = !!me && laneHasOwner(ctx.lane, me.username);
  const tracking = !isOwner && (await trackingCheck);

  // Feed/Asks/Insights are this Lane's own history only -- never
  // aggregated across its rollup (that's what the Lanes sub-tab, a
  // navigable tree, is for instead).
  const feedHtml = renderFeedHtml(lane.history, repoSlug, laneId);
  const asksListHtml = renderAsksHtml(lane.history);
  const insightsListHtml = renderInsightsHtml(lane.history);
  const lanesHtml = await lanesRollupPromise;
  const graphHtml = await renderGraphHtml(env, repoSlug, repoRow.artifacts_name, info.defaultBranch);

  const cloneUrl = `${origin}/${repoSlug}`;
  const checkoutCmd = `zz lane checkout ${repoSlug}`;
  const workCmd = `zz work --repos ${repoSlug}`;

  const gitDetailsHtml = `<div class="clone-row" style="margin:0 0 .75rem">
      <div class="pre-wrap">
        <pre>git clone ${esc(cloneUrl)}</pre>
        <button class="secondary icon-btn" data-copy="${esc(`git clone ${cloneUrl}`)}" title="Copy clone command">⧉</button>
      </div>
    </div>
    <p class="hint">Plain git, no zz credential helper -- works with a token embedded in the URL or entered when git prompts, same as any other host. <code>zz lane checkout</code> (above) sets up the short-lived credential helper instead, so you don't have to.</p>
    <ul class="list">
      <li class="row"><span class="rung">remote</span> <span class="mono">${esc(cloneUrl)}</span></li>
      <li class="row"><span class="rung">default branch</span> <span class="mono">${esc(info.defaultBranch)}</span></li>
      ${KNOWN_LADDER_NOTES_REFS.map((r) => `<li class="row"><span class="rung">Ladder notes</span> <span class="mono">${esc(r)}</span></li>`).join("")}
    </ul>`;

  // #62 follow-up (real-time polling): every data-live-panel wrapper
  // below carries its own data-live-repo/data-live-lane (and, for
  // Commits, data-live-page) -- zzLivePanel (WEB_JS) reads these to
  // build each panel's own fragment URL and polls it, replacing this
  // div's innerHTML with the SAME markup renderXHtml above would
  // produce for the current data, never a second client-side
  // renderer. The initial server-rendered content below is what a
  // poll would ALSO return right now -- no special first-paint case.
  const livePanelAttrs = (panel: string, extra = ""): string => `data-live-panel="${esc(panel)}" data-live-repo="${esc(repoSlug)}" data-live-lane="${esc(laneId)}"${extra}`;

  const activityTabs = [
    { id: "feed", label: "Feed", html: `<div class="log-feed" ${livePanelAttrs("feed")}>${feedHtml}</div>` },
    { id: "lanes", label: "Lanes", html: `<div ${livePanelAttrs("lanes")}>${lanesHtml}</div>` },
    {
      id: "asks",
      label: "Asks",
      html: `<form class="field-row" data-post-ask-form data-post-ask-repo="${esc(repoSlug)}" data-post-ask-lane="${esc(laneId)}">
               <input name="description" placeholder="describe a task..." style="flex:3" required>
               <button type="submit">Post</button>
             </form>
             <div ${livePanelAttrs("asks")}>${asksListHtml}</div>`,
    },
  ];

  // #62 follow-up: Context is now just the Graph, no sub-tabs of its
  // own -- README moved to a "Read more" fold under the description
  // (card-head, below) instead of competing for a tab slot, and
  // Insights lifted to its own main tab instead of hiding under this
  // one.
  const ladderGraphHtml = `<div class="ladder-filter-bar" data-ladder-filter-bar>
      <input type="search" class="ladder-search" placeholder="filter..." data-ladder-search oninput="zzFilterLadder(this.closest('[data-ladder-filter-bar]'))">
      <select class="ladder-kind-select" data-ladder-kind-filter onchange="zzFilterLadder(this.closest('[data-ladder-filter-bar]'))">
        <option value="">all kinds</option>
        ${Object.keys(LADDER_KIND_ORDER)
          .map((k) => `<option value="${esc(k)}">${esc(k)}</option>`)
          .join("")}
      </select>
    </div>
    <div ${livePanelAttrs("graph")}>${graphHtml}</div>`;

  const codeTabs = [
    { id: "files", label: "Files", html: `<ul class="list">${fileListHtml || '<li class="empty">Empty.</li>'}</ul>` },
    { id: "commits", label: "Commits", html: `<div ${livePanelAttrs("commits", ` data-live-page="${commitsPage}"`)}>${commitsHtml}</div>${commitsPagerHtml}` },
    { id: "git", label: "Git", html: gitDetailsHtml },
  ];

  // #62 follow-up: a sub-tab group (Feed/Lanes/Asks inside Activity,
  // e.g.) is NOT its own nested .card -- that gave it a second,
  // indented/bordered frame sitting inside the main tab's own card,
  // which read as a box-inside-a-box instead of one continuous
  // surface. Plain, full-width, no border/padding of its own -- only
  // the top-level mainTabGroup below still gets the card treatment.
  const tabGroup = (groupId: string, tabs: { id: string; label: string; html: string }[]): string => `
    <div class="sub-tabs" data-tabs>
      <div class="tab-bar">${tabs.map((t, i) => `<button type="button" class="tab-btn${i === 0 ? " active" : ""}" data-target="${groupId}-${t.id}">${esc(t.label)}</button>`).join("")}</div>
      ${tabs.map((t, i) => `<div id="${groupId}-${t.id}" class="tab-panel"${i === 0 ? "" : " hidden"}>${t.html}</div>`).join("")}
    </div>`;

  const mainTabGroup = (tabs: { id: string; label: string; html: string }[]): string => `
    <div class="card" data-tabs>
      <div class="tab-bar main-tab-bar">${tabs.map((t, i) => `<button type="button" class="tab-btn${i === 0 ? " active" : ""}" data-target="main-${t.id}">${esc(t.label)}</button>`).join("")}</div>
      ${tabs.map((t, i) => `<div id="main-${t.id}" class="tab-panel"${i === 0 ? "" : " hidden"}>${t.html}</div>`).join("")}
    </div>`;

  // #67: the README IS the description now -- readmeFoldHtml (above
  // the fold always visible, the rest behind a plain toggle) replaces
  // the old separate "description" field + its own distinct "Read
  // more" block entirely. Falls back to the Ladder's own root rung, or
  // the one-time-seed description, only for a Lane with no README at
  // all (readme === null) -- there's nothing to fold in that case, no
  // toggle shown.
  const descriptionHtml = readme
    ? readmeFoldHtml(readme, repoSlug, info.defaultBranch)
    : `<p>${autolinkText(ladder?.summary ?? meta?.description ?? repoRow.description ?? "")}</p>`;

  const activityActionsHtml = `<div class="field-row" style="flex-wrap:nowrap">
      <div class="clone-row" style="flex:1;margin:0">
        <div class="pre-wrap">
          <pre>${esc(workCmd)}</pre>
          <button class="secondary icon-btn" data-copy="${esc(workCmd)}" title="Copy">⧉</button>
        </div>
      </div>
      <a href="/docs/install/" style="flex:none"><button class="secondary">Install zz</button></a>
    </div>
    <p class="hint">Join as a worker: run that from a terminal logged in via <code>zz login</code> to pick up and work this Lane's Asks, same as any other agent.</p>`;

  const codeActionsHtml = `<div class="field-row" style="flex-wrap:nowrap">
      <div class="clone-row" style="flex:1;margin:0">
        <div class="pre-wrap">
          <pre>${esc(checkoutCmd)}</pre>
          <button class="secondary icon-btn" data-copy="${esc(checkoutCmd)}" title="Copy">⧉</button>
        </div>
      </div>
      <a href="${origin}/${esc(repoSlug)}/archive.zip" style="flex:none"><button class="secondary">Download .zip</button></a>
    </div>
    <p class="hint">To push: issue yourself (or a managed agent) a token on <a href="${me ? `/${esc(me.username)}` : "/login"}">your profile</a> (needs at least Coordinator). <code>zz lane checkout ${esc(repoSlug)}</code> does this automatically when logged in via the CLI.</p>`;

  const [ownerUsername] = repoSlug.split("/");
  return layout(
    `${repoSlug}${isOriginLane ? "" : `/${lane.id}`}`,
    me,
    `<div class="card">
       ${repoRow.ingest_status === "ingesting" ? `<p><span class="badge badge-yellow">⏳ ingesting</span> <span class="muted">still importing -- content below may be incomplete until this finishes.</span></p>` : ""}
       <div class="card-head">
         <div></div>
         ${
           me && !isOwner
             ? `<form method="post" action="/${esc(repoSlug)}/${tracking ? "untrack" : "track"}" class="inline"><button type="submit" class="secondary" title="${tracking ? "Stop tracking this Lane" : "Track this Lane"}">${tracking ? "★ Tracking" : "☆ Track"}</button></form>`
             : ""
         }
         ${isOwner ? `<a href="/${esc(repoSlug)}/settings"><button class="icon-btn" title="Settings">⚙</button></a>` : ""}
       </div>
       ${descriptionHtml}
       <div class="split">
         <details class="summary-detail"><summary>Actors</summary><ul class="list">${actorsHtml || '<li class="empty">None.</li>'}</ul></details>
         ${policyPanelHtml(meta ? normalizePolicy(meta.policy) : DEFAULT_REPO_POLICY)}
       </div>
     </div>

     ${mainTabGroup([
       { id: "activity", label: "Activity", html: `${activityActionsHtml}${tabGroup("activity", activityTabs)}` },
       { id: "context", label: "Context Graph", html: ladderGraphHtml },
       { id: "insights", label: "Insights", html: `<div ${livePanelAttrs("insights")}>${insightsListHtml}</div>` },
       { id: "code", label: "Code", html: `${codeActionsHtml}${tabGroup("code", codeTabs)}` },
     ])}`,
    {
      h1Html: `<a href="/${esc(ownerUsername)}">${esc(ownerUsername)}</a>/${esc(repoSlug.split("/")[1])}${isOriginLane ? "" : ` <span class="lane-tag"><span class="text">${esc(lane.id)}</span></span>`}`,
      titleHtml: `<span class="badge badge-${visibility === "private" ? "red" : "muted"}">${esc(visibility)}</span>`,
    },
  );
}

/**
 * #62 follow-up (real-time polling): returns just one Lane page panel's
 * own fresh inner markup -- the fragment zzLivePanel (WEB_JS) polls and
 * swaps in, via the exact same render functions handleLanePage's own
 * first paint uses, so a poll's content never drifts from what a full
 * reload would show for the same data. Plain text/html, not JSON --
 * the client does a direct innerHTML swap, no client-side rendering.
 */
async function handleLaneFragment(repoSlug: string, laneId: string, panel: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(repoSlug, env);
  if (!ctx) return new Response("not found", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.lane))) return new Response("not found", { status: 404 });
  const { repoRow } = ctx;
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

  switch (panel) {
    case "lanes":
      return html(await renderLanesRollupHtml(env, repoSlug, laneId));
    case "graph": {
      using repo = await env.ARTIFACTS.get(repoRow.artifacts_name);
      const info = await repo.info();
      return html(await renderGraphHtml(env, repoSlug, repoRow.artifacts_name, info.defaultBranch));
    }
    case "commits": {
      const commitsPage = Math.max(1, Number(new URL(request.url).searchParams.get("page")) || 1);
      const { html: commitsHtml } = await renderCommitsHtml(env, repoSlug, repoRow.artifacts_name, laneId, commitsPage);
      return html(commitsHtml);
    }
    case "feed":
    case "asks":
    case "insights": {
      const lane = laneId === ctx.lane.id ? ctx.lane : await getLaneById(env, repoRow.artifacts_name, laneId);
      if (!lane) return new Response("not found", { status: 404 });
      if (panel === "feed") return html(renderFeedHtml(lane.history, repoSlug, laneId));
      if (panel === "asks") return html(renderAsksHtml(lane.history));
      return html(renderInsightsHtml(lane.history));
    }
    default:
      return new Response("unknown panel", { status: 400 });
  }
}

async function handleRepoSettings(slug: string, request: Request, env: WebEnv): Promise<Response> {
  const me = await resolveRequestAgent(request, env);
  if (!me) return redirect("/login");
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("no such Lane", { status: 404 });
  const { meta, lane } = ctx;
  if (!laneHasOwner(lane, me.username)) return new Response("Owners only", { status: 403 });

  // Direct shards only, for the count shown here -- the actual
  // cleanup (doCleanupShards) recurses to shards of shards itself;
  // this is just "does the button need to show at all."
  const directShards = await listShardsOf(env.DB, slug);

  const laneGrantRows: { principal: string; role: "owner" | "coordinator" | "viewer" }[] = [
    ...lane.owners.map((principal) => ({ principal, role: "owner" as const })),
    ...lane.coordinators.map((principal) => ({ principal, role: "coordinator" as const })),
    ...lane.viewers.map((principal) => ({ principal, role: "viewer" as const })),
  ];
  const roleRows = laneGrantRows
    .map(
      (g) => `<li class="row">
        ${formatAgentId(g.principal)}
        <form method="post" action="/${esc(slug)}/settings/roles" class="row inline">
          <input type="hidden" name="principal" value="${esc(g.principal)}">
          <select name="role" class="role-select" disabled>
            ${(["owner", "coordinator", "viewer"] as const).map((r) => `<option value="${r}"${r === g.role ? " selected" : ""}>${r}</option>`).join("")}
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
       `<p class="hint">Public Lanes are readable by anyone; private ones need an explicit role grant above to even view.</p>
        <form method="post" action="/${esc(slug)}/settings/visibility" class="row">
          <select name="visibility"><option value="public"${visibility === "public" ? " selected" : ""}>public</option><option value="private"${visibility === "private" ? " selected" : ""}>private</option></select>
          <button type="submit" class="secondary">Save</button>
        </form>`,
     )}

     ${card(
       "Danger zone",
       `<div class="stack">
          <form method="post" action="/${esc(slug)}/settings/transfer" class="field-row">
            <button type="submit" class="danger">Transfer ownership</button>
            ${agentAutocompleteField("new_owner", "new owner (agent name or id)", "transfer")}
          </form>
          ${
            directShards.length > 0
              ? `<form method="post" action="/${esc(slug)}/settings/cleanup-shards" onsubmit="return confirm('Permanently delete every Lane split off from ${esc(slug).replace(/'/g, "\\'")} (and any split from those)? This cannot be undone.')">
            <button type="submit" class="danger">Clean up related Lanes</button>
          </form>`
              : ""
          }
          <form method="post" action="/${esc(slug)}/settings/delete" onsubmit="return confirm('Permanently delete ${esc(slug).replace(/'/g, "\\'")}? This cannot be undone.')">
            <button type="submit" class="danger">Delete Lane</button>
          </form>
        </div>`,
       { extraClass: "danger-zone" },
     )}

     <dialog id="modal-add-role" class="modal"><div class="modal-body">
       <h3>Add a role</h3>
       <form method="post" action="/${esc(slug)}/settings/roles" class="stack">
         ${agentAutocompleteField("principal", "agent name or id", "add-role")}
         <select name="role"><option>owner</option><option>coordinator</option><option selected>contributor</option><option>viewer</option></select>
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
  if (!ctx) return new Response("no such Lane", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.lane))) return new Response("no such Lane", { status: 404 });
  const me = await resolveRequestAgent(request, env);

  // Started here, awaited down by the render -- a separate DO
  // round-trip with no dependency on the Artifacts reads that follow,
  // so there's no reason to serialize behind them. A changeset rung's
  // path IS "changesets/<sha>", so this is one direct read.
  const ladderRung = readLadderRung(env, ctx.repoRow.artifacts_name, `changesets/${sha}`);

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

  // Each filechange rung is about one specific file in this commit, so
  // its summary belongs on that file's own row in the tree below, not
  // bundled into one combined block up here -- the changeset rung's
  // OWN summary is the only one that's actually about the commit as a
  // whole. A filechange's path is "changesets/<sha>/<filename>" (or
  // sometimes just "<filename>"), so match on the last path segment
  // either way.
  const changesetRung = await ladderRung;
  const fileSummaries = new Map<string, string>();
  for (const child of changesetRung?.children ?? []) {
    if (isRef(child)) continue;
    fileSummaries.set(child.path.split("/").pop() ?? child.path, child.summary);
  }

  // sha as ref -- clicking into a file or directory from this
  // historical commit's own tree stays pinned to it, not HEAD.
  const fileListHtml = fileListRowsHtml(slug, sha, "", tree, (name) => fileSummaries.get(name));

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
      ${changesetRung ? summaryDetailHtml(changesetRung.summary) : ""}
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
async function handleDownload(slug: string, ref: string, path: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("not found", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.lane))) return new Response("not found", { status: 404 });
  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  const blob = await repo.readFile({ ref: await resolveRefName(repo, ref), path });
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

interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

// A plain LCS line diff, same algorithm `git diff` itself is built on
// (minus its hunk-context collapsing -- this shows the whole file,
// every line tagged same/add/del, not just the changed neighborhoods,
// since the blob page already shows the whole file either way). The
// DP table is O(n*m) time AND space, so capped well below what a
// Worker's own CPU/memory budget could choke on for a genuinely huge
// generated file -- plenty of headroom for any real source file.
const DIFF_LINE_CAP = 2000;
function diffLines(oldText: string, newText: string): DiffLine[] | null {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length > DIFF_LINE_CAP || newLines.length > DIFF_LINE_CAP) return null;

  const n = oldLines.length;
  const m = newLines.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ kind: "same", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ kind: "del", text: oldLines[i] });
      i++;
    } else {
      result.push({ kind: "add", text: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ kind: "del", text: oldLines[i] });
    i++;
  }
  while (j < m) {
    result.push({ kind: "add", text: newLines[j] });
    j++;
  }
  return result;
}

/** Plain text, not syntax-highlighted -- hljs operates on one contiguous block, and a per-line diff's added/removed rows would need highlighting each line in isolation (no surrounding context for hljs's own lexer) to compose into this, a real gap but a separate, larger piece of work than this view's own point: making a historical commit's change to this file legible at all, which a plain file render -- what every other ref used to show here too -- already was not. */
function diffLinesHtml(diff: DiffLine[]): string {
  return diff
    .map((l) => {
      const prefix = l.kind === "add" ? "+" : l.kind === "del" ? "-" : "&nbsp;";
      const cls = l.kind === "add" ? "diff-add" : l.kind === "del" ? "diff-del" : "diff-same";
      return `<div class="${cls}"><span class="diff-marker">${prefix}</span>${esc(l.text)}</div>`;
    })
    .join("");
}

/** The file viewer page: syntax-highlighted (via highlight.js from cdnjs -- a real CDN dependency, not hand-rolled, since this is a normal deployed website, not a sandboxed Artifact), line-numbered, with a header (repo, latest commit, path, download). GitHub's /blob/ convention -- this is the page a file link lands on; /download/ is the actual bytes now. */
async function handleBlob(slug: string, ref: string, path: string, request: Request, env: WebEnv): Promise<Response> {
  const ctx = await getRepoAccessContext(slug, env);
  if (!ctx) return new Response("not found", { status: 404 });
  if (!(await canReadRepo(request, env, ctx.meta, ctx.lane))) return new Response("not found", { status: 404 });
  const me = await resolveRequestAgent(request, env);

  // Started here, awaited down by the render -- a separate DO
  // round-trip with no dependency on the Artifacts reads that follow.
  // A file rung's path IS the file's own path, so this is one direct
  // read, no searching. Always the current Ladder summary regardless
  // of `ref` -- a rung tracks a file's current state, not a per-commit
  // history of it, so there's nothing more "correct" to show for an
  // older ref here even though the code body itself is pinned to one.
  const ladderRung = readLadderRung(env, ctx.repoRow.artifacts_name, path);

  using repo = await env.ARTIFACTS.get(ctx.repoRow.artifacts_name);
  // ref resolves a branch, tag, or commit sha directly (both calls
  // below) -- the same ref a historical commit's own tree view links
  // here with, so the file shown is that commit's version, not HEAD's.
  ref = await resolveRefName(repo, ref);
  const info = await repo.info();
  const [blob, [head], [trueHead]] = await Promise.all([repo.readFile({ ref, path }), repo.log({ ref, limit: 1 }), repo.log({ ref: info.defaultBranch, limit: 1 })]);
  if (!blob) return new Response("not found", { status: 404 });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";

  // Not HEAD's own current version of this file (a real historical
  // commit, reached via that commit's own tree/changeset view) --
  // show what changed right there instead of just the plain file:
  // the filechange rung's own "what and why" alongside an inline
  // diff against the immediate parent, so you don't have to go dig
  // up the commit page separately to see either. HEAD itself (and a
  // commit with no parent -- the repo's very first) keeps the plain
  // view, same as always: there's no "what changed to get here" to
  // show for either.
  const isHistorical = !!head && head.hash !== trueHead?.hash;
  const parentSha = head?.parents[0];
  let diffHtml: string | null = null;
  let filechangeSummary: string | null = null;
  if (isHistorical && parentSha && !looksBinary(bytes)) {
    const [oldBlob, changesetRung] = await Promise.all([repo.readFile({ ref: parentSha, path }), readLadderRung(env, ctx.repoRow.artifacts_name, `changesets/${head!.hash}`)]);
    const oldText = oldBlob ? new TextDecoder().decode(new Uint8Array(await oldBlob.arrayBuffer())) : "";
    const newText = new TextDecoder().decode(bytes);
    const diff = diffLines(oldText, newText);
    if (diff) diffHtml = diffLinesHtml(diff);
    const basename = path.split("/").pop() ?? path;
    const filechange = (changesetRung?.children ?? []).find((c) => !isRef(c) && (c.path === path || c.path.split("/").pop() === basename));
    filechangeSummary = filechange && !isRef(filechange) ? filechange.summary : null;
  }

  // Nested inside .blob-header, not a sibling block after it -- a
  // sibling would land in the gap between the header's rounded-top
  // border and the body's rounded-bottom one (the two only look like
  // one continuous box because the body has no top border), breaking
  // that illusion. Staying inside the header's own border keeps it intact.
  const headerHtml = `<div class="blob-header">
    <span>${pathBreadcrumbHtml(slug, ref, path, false)}</span>
    ${head ? ` @ <a href="/${esc(slug)}/commit/${esc(head.hash)}" class="mono">${esc(head.hash.slice(0, 8))}</a>` : ""}
    <a href="/${esc(slug)}/download/${esc(ref)}/${esc(path)}" class="download-btn" download>Download</a>
    ${filechangeSummary ? summaryDetailHtml(filechangeSummary) : ladderDetailHtml(await ladderRung)}
  </div>`;

  if (looksBinary(bytes)) {
    return layout(path, me, `${headerHtml}<div class="card">Binary file not shown.</div>`);
  }

  const text = new TextDecoder().decode(bytes);

  if (diffHtml) {
    return layout(path, me, `${headerHtml}<div class="blob-body"><div class="diff-body">${diffHtml}</div></div>`);
  }

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
  if (!(await canReadRepo(request, env, ctx.meta, ctx.lane))) return new Response("not found", { status: 404 });
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

async function checkGitServiceAccess(service: GitService, request: Request, env: WebEnv, ctx: { meta: Awaited<ReturnType<typeof readRepoMeta>>; lane: Lane }): Promise<"ok" | "need-auth" | "denied"> {
  if (service === "git-receive-pack") {
    if (await canPushRepo(request, env, ctx.lane)) return "ok";
    return request.headers.get("authorization") ? "denied" : "need-auth";
  }
  if (await canReadRepo(request, env, ctx.meta, ctx.lane)) return "ok";
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
  // Decoded once, up front: a username (now a literal did:guardian
  // string, e.g. "did:guardian:alice:zzmq.dev") can contain ":" --
  // not in the WHATWG URL spec's path percent-encode set, so a
  // conformant browser leaves it literal in `pathname` (confirmed
  // live: a route built from `agent.username` works as-is). But a
  // client that DOES percent-encode it anyway (confirmed live:
  // `encodeURIComponent`, which some CLI/API call sites reasonably
  // reach for) would otherwise 404 forever, since every lookup below
  // (getRepoBySlug, getAgent, ...)
  // compares against the literal, undecoded form stored in D1.
  // Decoding here once means every route matches either form the same
  // way, instead of every individual call site needing to know which
  // encoding its particular caller happened to use.
  const path = decodeURIComponent(url.pathname);
  const origin = url.origin;

  if (path === "/login") return handleLogin(request, env);
  if (path === "/logout") return handleLogout(request, env);
  if (path === "/auth/start/cloudflare") return handleAuthStart("cloudflare", request, env);
  if (path === "/auth/start/google") return handleAuthStart("google", request, env);
  if (path === "/auth/start/github") return handleAuthStart("github", request, env);
  if (path === "/auth/callback/cloudflare") return handleAuthCallback("cloudflare", request, env);
  if (path === "/auth/callback/google") return handleAuthCallback("google", request, env);
  if (path === "/auth/callback/github") return handleAuthCallback("github", request, env);
  if (path === "/auth/guardian/start" && request.method === "POST") return handleGuardianStart(request, env);
  if (path === "/auth/callback/didguardian") return handleGuardianAuthCallback(request, env);
  if (path === "/onboard/guardian-name" && request.method === "GET") return handleGuardianNameFormGet(request, env);
  if (path === "/onboard/guardian-name" && request.method === "POST") return handleGuardianNameFormPost(request, env);
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
  {
    const m = path.match(/^\/profile\/tokens\/([^/]+)\/revoke$/);
    if (m && request.method === "POST") return handleRevokeTokenForm(m[1], request, env);
  }
  {
    const m = path.match(/^\/profile\/identities\/([^/]+)\/disconnect$/);
    if (m && request.method === "POST") return handleDisconnectProvider(m[1], request, env);
  }
  if (path === "/profile/login-secret/reissue" && request.method === "POST") return handleReissueLoginSecret(request, env);
  if (path === "/profile/key/rotate" && request.method === "POST") return handleRotateOwnKey(request, env);
  if (path === "/explore") return handleExplore(request, env);
  if (path === "/work" && request.method === "GET") return handleWorkPage(request, env);
  if (path === "/work/claim" && request.method === "POST") return handleWorkClaimForm(request, env);
  if (path === "/api/explore/search" && request.method === "GET") return handleApiExploreSearch(request, env);
  if (path === "/api/ladder/search" && request.method === "GET") return handleApiLadderSearch(request, env);

  // --- JSON API (CLI/agent parity with everything above) ---
  if (path === "/api/login/start" && request.method === "POST") return handleApiLoginStart(request, env);
  if (path === "/api/login/poll" && request.method === "GET") return handleApiLoginPoll(request, env);
  if (path === "/api/me" && request.method === "GET") return handleApiMe(request, env);
  if (path === "/api/me/repos" && request.method === "GET") return handleApiMyRepos(request, env);
  if (path === "/api/me/revoke" && request.method === "POST") return handleApiRevokeSelf(request, env);
  if (path === "/api/me/set-name" && request.method === "POST") return handleApiSetOwnName(request, env);
  if (path === "/api/agents" && request.method === "POST") return handleApiCreateAgent(request, env);
  if (path === "/api/agents" && request.method === "GET") return handleApiListAgents(request, env);
  if (path === "/api/me/managed-identity/register" && request.method === "POST") return handleApiRegisterManagedIdentity(request, env);
  if (path === "/api/me/managed-identity/resolve" && request.method === "POST") return handleApiResolveManagedIdentity(request, env);
  if (path === "/api/agents/search" && request.method === "GET") return handleApiSearchAgents(request, env);
  if (path === "/api/repos" && request.method === "POST") return handleApiCreateRepo(request, env);
  if (path === "/api/repos" && request.method === "GET") return handleApiListRepos(request, env);
  {
    const m = path.match(/^\/api\/lanes\/([^/]+)$/);
    if (m && request.method === "GET") return handleApiLaneLookup(m[1], request, env);
  }
  {
    const m = path.match(/^\/api\/agents\/([^/]+)\/tokens$/);
    if (m && request.method === "POST") return handleApiMintToken(m[1], request, env);
  }
  {
    const m = path.match(/^\/api\/agents\/([^/]+)\/rotate-key$/);
    if (m && request.method === "POST") return handleApiRotateKey(m[1], request, env);
  }
  {
    const m = path.match(/^\/api\/agents\/([^/]+)$/);
    if (m && request.method === "DELETE") return handleApiDeleteAgent(m[1], request, env);
  }
  {
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/roles$/);
    if (m && request.method === "POST") return handleApiRbacGrant(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/ingest-status$/);
    if (m && request.method === "POST") return handleApiSetIngestStatus(`${m[1]}/${m[2]}`, request, env);
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
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/track$/);
    if (m && request.method === "POST") return handleApiTrack(`${m[1]}/${m[2]}`, true, request, env);
  }
  {
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/untrack$/);
    if (m && request.method === "POST") return handleApiTrack(`${m[1]}/${m[2]}`, false, request, env);
  }
  {
    const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)$/);
    if (m && request.method === "GET") return handleApiGetRepo(`${m[1]}/${m[2]}`, env);
    if (m && request.method === "DELETE") return handleApiDeleteRepo(`${m[1]}/${m[2]}`, request, env);
  }

  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/archive\.zip$/);
    if (m) return handleArchive(`${m[1]}/${m[2]}`, request, env);
  }
  {
    // ref is always a required, separate path segment (a branch name,
    // tag, or commit sha) -- /tree/<ref> alone (no path) is the repo
    // root at that ref, same as GitHub's own convention.
    const m = path.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (m) return handleBlob(`${m[1]}/${m[2]}`, m[3], m[4], request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/);
    if (m) return handleTree(`${m[1]}/${m[2]}`, m[3], m[4] ?? "", request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/download\/([^/]+)\/(.+)$/);
    if (m) return handleDownload(`${m[1]}/${m[2]}`, m[3], m[4], request, env);
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
    const m = path.match(/^\/([^/]+)\/([^/]+)\/settings\/cleanup-shards$/);
    if (m && request.method === "POST") return handleCleanupShardsForm(`${m[1]}/${m[2]}`, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/track$/);
    if (m && request.method === "POST") return handleTrackForm(`${m[1]}/${m[2]}`, true, request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/untrack$/);
    if (m && request.method === "POST") return handleTrackForm(`${m[1]}/${m[2]}`, false, request, env);
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
    // #62 follow-up (real-time polling): one Lane page panel's own
    // fresh fragment -- zzLivePanel (WEB_JS) polls this, not the full
    // page. Matched before the plain lane-page routes below, same
    // specific-before-general necessity as every other route here.
    const m = path.match(/^\/([^/]+)\/([^/]+)\/lane\/([^/]+)\/fragment\/([^/]+)$/);
    if (m && request.method === "GET") return handleLaneFragment(`${m[1]}/${m[2]}`, m[3], m[4], request, env);
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)\/fragment\/([^/]+)$/);
    if (m && request.method === "GET") return handleLaneFragment(`${m[1]}/${m[2]}`, ORIGIN_LANE_ID, m[3], request, env);
  }
  {
    // #62: a non-origin lane_id within this same repo -- its own
    // standalone page, not just an anchor on the repo's own. Matched
    // before the bare two-segment route below, same necessity as every
    // other specific-suffix route above it.
    const m = path.match(/^\/([^/]+)\/([^/]+)\/lane\/([^/]+)$/);
    if (m && request.method === "GET") {
      const me = await resolveRequestAgent(request, env);
      return handleLanePage(me, `${m[1]}/${m[2]}`, m[3], request, env, origin);
    }
  }
  {
    const m = path.match(/^\/([^/]+)\/([^/]+)$/);
    if (m) {
      const me = await resolveRequestAgent(request, env);
      return handleLanePage(me, `${m[1]}/${m[2]}`, ORIGIN_LANE_ID, request, env, origin);
    }
  }
  {
    const m = path.match(/^\/([^/]+)$/);
    if (m && request.method === "GET") return handleAgentPage(m[1], request, env);
  }

  return null;
}

export { upsertRepo, type RepoRow, type Agent };
