// #27: make Lane/Ask/Answer history portable -- exported onto the
// zz-meta branch (same real, git-native home Policy/Role grants
// already have), not Durable-Object-only. "D1 and Durable Object
// storage are never the only copy of a decision"
// (site/content/docs/architecture/#portability) was violated for
// every Vote, VETO, Insight, whistleblow report, and mediation
// exchange until this.
//
// Append-only, one file per history entry, never rewritten again --
// storage grows with real activity, not with how large a Lane's
// history has already gotten (a naive full-snapshot-per-write design
// would re-store the whole, ever-growing history array on every
// single write). The small, genuinely mutable header (status,
// coordinators/committee/owners/viewers, related_lanes, budget) is
// the one thing that does get overwritten each time -- no bloat
// concern for a constant-size file.
import type { Lane } from "../../engine/types.js";
import { writeMetaFiles } from "./repoMeta.js";

function laneHeaderFields(lane: Lane): Omit<Lane, "history"> {
  const { history: _history, ...header } = lane;
  return header;
}

/**
 * Writes every history entry from `fromIndex` onward (never already
 * exported, per the caller's own durably-tracked progress) plus a
 * fresh header, in one zz-meta commit. The caller is responsible for
 * serializing calls for the same repo (concurrent exports racing on
 * the same zz-meta tree would clobber each other) and for advancing
 * its own progress marker only after this resolves successfully.
 */
export async function exportLaneIncrement(remote: string, token: { plaintext: string } | string, lane: Lane, fromIndex: number): Promise<void> {
  const base = `lanes/${lane.id}`;
  const files: { path: string; content: string }[] = [{ path: `${base}/header.json`, content: JSON.stringify(laneHeaderFields(lane), null, 2) }];
  for (let i = fromIndex; i < lane.history.length; i++) {
    const index = String(i).padStart(6, "0");
    files.push({ path: `${base}/history/${index}.json`, content: JSON.stringify(lane.history[i], null, 2) });
  }
  const newCount = lane.history.length - fromIndex;
  const message = `zz-lane: ${lane.id} +${newCount} ${newCount === 1 ? "entry" : "entries"} (${lane.history.length} total)`;
  await writeMetaFiles(remote, token, files, message);
}
