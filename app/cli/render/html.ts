// A clean, self-contained HTML page for a Ladder, in the spirit of a
// Claude Artifact: readable typography, light/dark aware, no build step
// or external resources, collapsible nesting via plain <details> so it
// needs no JS at all.
import type { ResolvedRung } from "../../engine/ladderRender.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderNode(rung: ResolvedRung, depth: number): string {
  const sources = rung.sources.length
    ? `<ul class="sources">${rung.sources
        .map((s) => `<li><span class="kind">${escapeHtml(s.kind)}</span> <code>${escapeHtml(s.ref)}</code> <time>${escapeHtml(s.at)}</time> ${escapeHtml(s.author)}: ${escapeHtml(s.title)}</li>`)
        .join("")}</ul>`
    : "";
  const touches = rung.touches?.length ? `<p class="touches">touches: ${rung.touches.map((t) => `<code>${escapeHtml(t)}</code>`).join(", ")}</p>` : "";
  const children = rung.children.map((c) => renderNode(c, depth + 1)).join("");

  const header = `<span class="kind-tag kind-${escapeHtml(rung.kind)}">${escapeHtml(rung.kind)}</span> <code class="path">${escapeHtml(rung.path)}</code>`;
  const body = `<p class="summary">${escapeHtml(rung.summary)}</p>${sources}${touches}${children ? `<div class="children">${children}</div>` : ""}`;

  if (depth === 0) {
    return `<section class="rung rung-root">${header}${body}</section>`;
  }
  // <details open> by default so the page reads top-to-bottom like the
  // text/JSON forms; a reader can collapse branches they don't care about.
  return `<details class="rung" open><summary>${header}</summary>${body}</details>`;
}

export function renderHtml(tree: ResolvedRung, meta: { repoSlug: string; generatedAt: string; stats: { rungs: number; notes: number } }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ladder: ${escapeHtml(meta.repoSlug)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf8; --fg: #1b1b18; --muted: #6b6a66; --line: #e4e2dd; --accent: #b34700; --code-bg: #f1efe9;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #15140f; --fg: #ece9e2; --muted: #9b988f; --line: #322f27; --accent: #ff9955; --code-bg: #1f1d17; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.5; max-width: 840px; margin-inline: auto;
  }
  header { margin-bottom: 2rem; }
  header h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  header p { color: var(--muted); margin: 0; font-size: 0.9rem; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.85em; }
  .rung { border-left: 2px solid var(--line); padding-left: 1rem; margin: 0.6rem 0 0.6rem 0.4rem; }
  .rung-root { border-left: none; padding-left: 0; margin-left: 0; }
  summary { cursor: pointer; font-weight: 600; padding: 0.15rem 0; }
  summary::marker { color: var(--muted); }
  .kind-tag {
    display: inline-block; text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.04em;
    color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0.1em 0.4em; margin-right: 0.4em;
  }
  .kind-ask { color: var(--accent); border-color: var(--accent); }
  .path { font-weight: 600; }
  .summary { margin: 0.3rem 0 0.2rem; }
  ul.sources { list-style: none; margin: 0.2rem 0 0.3rem; padding: 0; font-size: 0.85rem; color: var(--muted); }
  ul.sources li { padding: 0.1rem 0; }
  .kind { text-transform: uppercase; font-size: 0.7rem; }
  .touches { font-size: 0.85rem; color: var(--muted); margin: 0.2rem 0; }
  .children { margin-top: 0.3rem; }
  footer { margin-top: 3rem; color: var(--muted); font-size: 0.8rem; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Ladder: ${escapeHtml(meta.repoSlug)}</h1>
  <p>${meta.stats.rungs} rungs, from ${meta.stats.notes} git notes. Generated ${escapeHtml(meta.generatedAt)}.</p>
</header>
${renderNode(tree, 0)}
<footer>Materialized from refs/notes/zz/ladder/* for reading. Not a second source of truth.</footer>
</body>
</html>
`;
}
