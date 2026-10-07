// Renders a Ladder to flat, indented plain text for a human to read in one
// place. Reads from git notes the same way the engine would, not from any
// cache; this is a materialized view, not a second source of truth.
import { readAnchor, isRef, type EmbeddedRung } from "./ladderNotes.js";
import { REPO_RUNG_PATH } from "./ladder.js";

export interface RenderStats {
  rungs: number;
  notes: number;
}

export async function renderLadder(repoDir: string, stateDir: string): Promise<{ text: string; stats: RenderStats }> {
  const stats: RenderStats = { rungs: 0, notes: 0 };

  function renderOwnFields(rung: EmbeddedRung, depth: number): string {
    stats.rungs += 1;
    const indent = "  ".repeat(depth);
    const lines = [`${indent}[${rung.kind}] ${rung.path}`, `${indent}  ${rung.summary}`];
    if (rung.sources.length) {
      lines.push(`${indent}  sources:`);
      for (const s of rung.sources) {
        lines.push(`${indent}    - ${s.kind} ${s.ref} (${s.at}) ${s.author}: ${s.title}`);
      }
    }
    if (rung.touches?.length) {
      lines.push(`${indent}  touches: ${rung.touches.join(", ")}`);
    }
    return lines.join("\n");
  }

  // Walks one already-loaded subtree, re-reading from git notes (another
  // note) whenever a child is a reference rather than embedded content.
  async function renderNode(rung: EmbeddedRung, depth: number): Promise<string> {
    const lines = [renderOwnFields(rung, depth)];
    for (const child of rung.children) {
      if (isRef(child)) {
        const anchor = await readAnchor(repoDir, stateDir, child.ref);
        stats.notes += 1;
        lines.push(anchor ? await renderNode(anchor, depth + 1) : `${"  ".repeat(depth + 1)}[missing] ${child.ref}`);
      } else {
        lines.push(await renderNode(child, depth + 1));
      }
    }
    return lines.join("\n");
  }

  const root = await readAnchor(repoDir, stateDir, REPO_RUNG_PATH);
  stats.notes += 1;
  const text = root ? await renderNode(root, 0) : `[missing] ${REPO_RUNG_PATH}`;
  return { text, stats };
}
