// Materializes a Ladder into one resolved, nested tree -- reading from git
// notes the same way the engine would, not from any cache, so this is a
// view for reading, not a second source of truth. Every output format
// (text, JSON, HTML) renders from the same resolved tree instead of each
// re-walking git notes its own way.
import { readAnchor, isRef, type EmbeddedRung } from "./ladderNotes.js";
import { REPO_RUNG_PATH } from "./ladder.js";
import type { RungKind, RungSource } from "./ladder.js";

export interface ResolvedRung {
  path: string;
  kind: RungKind;
  summary: string;
  sources: RungSource[];
  touches?: string[];
  children: ResolvedRung[];
}

export interface RenderStats {
  rungs: number;
  notes: number;
}

/** The resolution logic itself, parameterized over how one anchor gets read -- shared by the local (git notes in a real clone) and remote (ladder_read tool calls against a deployed Worker, see tui/useLadderTrees.ts) paths so there's one walk of the tree, not two copies that can drift apart. */
export async function resolveLadderTree(readOneAnchor: (path: string) => Promise<EmbeddedRung | null>): Promise<{ tree: ResolvedRung; stats: RenderStats }> {
  const stats: RenderStats = { rungs: 0, notes: 0 };

  function resolveOwnFields(rung: EmbeddedRung): Omit<ResolvedRung, "children"> {
    stats.rungs += 1;
    return { path: rung.path, kind: rung.kind, summary: rung.summary, sources: rung.sources, touches: rung.touches };
  }

  async function resolveNode(rung: EmbeddedRung): Promise<ResolvedRung> {
    const children: ResolvedRung[] = [];
    for (const child of rung.children) {
      if (isRef(child)) {
        const anchor = await readOneAnchor(child.ref);
        stats.notes += 1;
        children.push(anchor ? await resolveNode(anchor) : { path: child.ref, kind: "ask", summary: "[missing]", sources: [], children: [] });
      } else {
        children.push(await resolveNode(child));
      }
    }
    return { ...resolveOwnFields(rung), children };
  }

  const root = await readOneAnchor(REPO_RUNG_PATH);
  stats.notes += 1;
  const tree = root ? await resolveNode(root) : { path: REPO_RUNG_PATH, kind: "repo" as RungKind, summary: "[missing]", sources: [], children: [] };
  return { tree, stats };
}

export async function collectLadder(repoDir: string, stateDir: string): Promise<{ tree: ResolvedRung; stats: RenderStats }> {
  return resolveLadderTree((path) => readAnchor(repoDir, stateDir, path));
}

export function renderText(tree: ResolvedRung, depth = 0): string {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}[${tree.kind}] ${tree.path}`, `${indent}  ${tree.summary}`];
  if (tree.sources.length) {
    lines.push(`${indent}  sources:`);
    for (const s of tree.sources) lines.push(`${indent}    - ${s.kind} ${s.ref} (${s.at}) ${s.author}: ${s.title}`);
  }
  if (tree.touches?.length) lines.push(`${indent}  touches: ${tree.touches.join(", ")}`);
  for (const child of tree.children) lines.push(renderText(child, depth + 1));
  return lines.join("\n");
}

/** Back-compat wrapper: collect + render text in one call, as the build script already uses. */
export async function renderLadder(repoDir: string, stateDir: string): Promise<{ text: string; stats: RenderStats }> {
  const { tree, stats } = await collectLadder(repoDir, stateDir);
  return { text: renderText(tree), stats };
}
