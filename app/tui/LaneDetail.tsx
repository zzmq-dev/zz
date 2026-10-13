// One Lane's own asks and their status -- what LaneList's "enter"
// pushes into (zz top's lanes tab, zz work --assist's lane picker):
// see what's already queued/answered, post a new one ("n"), or (in
// --assist only, via onViewAsk/onClaimAsk) view one's full detail
// (enter) or claim it and start a work session right from the list
// ("c") -- zz top passes neither callback, since it's a pure watcher
// with no work session to start; cursor navigation stays harmlessly
// inert there.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { LaneSnapshot } from "./types.js";
import type { ClaimableEntry } from "../engine/workqueue.js";
import { claimHolder } from "../engine/workqueue.js";
import type { AskEntry, AnswerEntry } from "../engine/types.js";
import { MUTED, CYAN, YELLOW, GREEN, RED } from "./theme.js";

export interface LaneDetailProps {
  repo: string;
  laneId: string;
  snapshots: LaneSnapshot[];
  maxRows: number;
  /** Who ask_post's own `from` field names, and whose claim a row's "(claimed)" suffix checks against -- null means not logged in, so "n" prompts to log in instead of opening the composer. */
  identity: string | null;
  onPostAsk: (repo: string, laneId: string, description: string) => Promise<void>;
  onBack: () => void;
  /** Mirrors Explore.tsx's own prop -- true while the ask-description box owns the keyboard, so the parent's own hotkeys pause the same way they do for Explore's search box. */
  onEditingChange?: (editing: boolean) => void;
  /** Overrides the derived-from-snapshots ask list with this one instead (AssistApp's own "unclaimed across all repos" pseudo-lane) -- repo/laneId above become purely cosmetic in that mode, and allowPost should be false (no single target lane to post into). */
  claimableEntries?: ClaimableEntry[];
  /** "enter" on a row -- view its full detail. A no-op (enter does nothing) when omitted, zz top's own case. */
  onViewAsk?: (entry: ClaimableEntry) => void;
  /** "c" on a row, or from the detail view it leads to -- claim it and start a work session. A no-op when omitted, zz top's own case. */
  onClaimAsk?: (entry: ClaimableEntry) => void;
  /** False disables "n" (post a new ask) -- default true. The unclaimed pseudo-lane has no single target lane to post into. */
  allowPost?: boolean;
}

// Only the first line -- a multi-line description's embedded newlines
// still render as real line breaks regardless of wrap="truncate-end"
// (that prop only truncates one too-long line, it doesn't collapse
// literal "\n"s), which broke this row's single-line layout. The full
// text is one "enter" away (the detail view).
function describePayload(payload: unknown): string {
  if (payload && typeof payload === "object" && "description" in payload) {
    const d = (payload as { description?: unknown }).description;
    if (typeof d === "string") return d.split("\n")[0];
  }
  return payload === undefined ? "" : JSON.stringify(payload).split("\n")[0];
}

function statusOf(ask: AskEntry, answers: AnswerEntry[]): { label: string; color: string } {
  const answer = answers.find((a) => a.ask === ask.id);
  if (!answer) return { label: "open", color: YELLOW };
  if (answer.action === "complete") return { label: "complete", color: GREEN };
  if (answer.action === "grant") return { label: "granted", color: GREEN };
  return { label: "denied", color: RED };
}

export function LaneDetail({ repo, laneId, snapshots, maxRows, identity, onPostAsk, onBack, onEditingChange, claimableEntries, onViewAsk, onClaimAsk, allowPost = true }: LaneDetailProps) {
  const [cursor, setCursor] = useState(0);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { isRawModeSupported } = useStdin();

  const snapshot = snapshots.find((s) => s.repo === repo && s.lane.id === laneId);
  const unclaimedMode = claimableEntries !== undefined;
  // Unified shape regardless of mode: a real lane's own history gets
  // wrapped into the same ClaimableEntry shape the unclaimed pseudo-
  // lane already comes in, so selection/view/claim never need to
  // branch on which mode produced a given row.
  const entries: ClaimableEntry[] = unclaimedMode
    ? claimableEntries
    : (snapshot?.lane.history.filter((e): e is AskEntry => e.type === "ASK") ?? [])
        .slice()
        .reverse() // newest first
        .map((a) => ({ repo, laneId, ask: a, alreadyClaimed: snapshot ? claimHolder(snapshot.lane, a.id) === identity : false }));
  const answers = unclaimedMode ? [] : (snapshot?.lane.history.filter((e): e is AnswerEntry => e.type === "ANSWER") ?? []);

  useEffect(() => {
    if (cursor >= entries.length) setCursor(Math.max(0, entries.length - 1));
  }, [entries.length, cursor]);

  useEffect(() => {
    onEditingChange?.(composing);
  }, [composing, onEditingChange]);

  useEffect(() => {
    if (!message || posting) return;
    const id = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(id);
  }, [message, posting]);

  useInput(
    (input, key) => {
      if (composing) {
        if (posting) return; // the post is in flight -- no input changes anything until it resolves
        if (key.escape) {
          setComposing(false);
          setDraft("");
          return;
        }
        if (key.return) {
          const text = draft.trim();
          if (!text) return;
          setPosting(true);
          setMessage("posting...");
          onPostAsk(repo, laneId, text)
            .then(() => {
              setMessage(`posted to ${repo}/${laneId}`);
              setComposing(false);
              setDraft("");
              setPosting(false);
            })
            .catch((err) => {
              setMessage(`failed: ${err instanceof Error ? err.message : String(err)}`);
              setPosting(false);
            });
          return;
        }
        if (key.backspace || key.delete) {
          setDraft((v) => v.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
          setDraft((v) => v + input);
        }
        return;
      }
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(entries.length - 1, c + 1));
        return;
      }
      if (key.return) {
        const entry = entries[cursor];
        if (entry) onViewAsk?.(entry);
        return;
      }
      if (input === "c") {
        const entry = entries[cursor];
        if (entry) onClaimAsk?.(entry);
        return;
      }
      if (input === "n" && allowPost) {
        if (!identity) {
          setMessage("log in first (l)");
          return;
        }
        setComposing(true);
      }
    },
    { isActive: isRawModeSupported },
  );

  const listRows = Math.max(1, maxRows - 2);
  const windowStart = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), Math.max(0, entries.length - listRows)));
  const shownEntries = entries.slice(windowStart, windowStart + listRows);

  return (
    <Box flexDirection="column">
      <Text bold color={CYAN} wrap="truncate-end">
        {unclaimedMode ? "unclaimed across all watched repos" : `${repo}/${laneId} -- ${snapshot?.lane.status ?? "unknown"}`} ({entries.length} ask{entries.length === 1 ? "" : "s"})
      </Text>
      {shownEntries.length === 0 ? (
        <Text color={MUTED}>{unclaimedMode ? "nothing claimable right now" : "no asks in this lane yet"}</Text>
      ) : (
        shownEntries.map((entry, i) => {
          const idx = windowStart + i;
          const current = idx === cursor;
          const { label, color } = unclaimedMode ? { label: entry.alreadyClaimed ? "claimed" : "open", color: entry.alreadyClaimed ? GREEN : YELLOW } : statusOf(entry.ask, answers);
          return (
            <Box key={entry.ask.id}>
              <Box flexShrink={0}>
                <Text color={current ? CYAN : undefined} bold={current}>
                  {current ? "> " : "  "}
                </Text>
              </Box>
              <Box width={16} marginRight={1} flexShrink={0}>
                <Text color={current ? CYAN : MUTED} bold={current} wrap="truncate-end">
                  {entry.ask.kind}
                </Text>
              </Box>
              <Box width={10} marginRight={1} flexShrink={0}>
                <Text bold color={color} wrap="truncate-end">
                  {label}
                </Text>
              </Box>
              {unclaimedMode && (
                <Box width={24} marginRight={1} flexShrink={0}>
                  <Text color={MUTED} wrap="truncate-end">
                    {entry.repo}
                  </Text>
                </Box>
              )}
              <Box width={20} marginRight={1} flexShrink={0}>
                <Text color={MUTED} wrap="truncate-end">
                  from {entry.ask.from}
                </Text>
              </Box>
              <Text wrap="truncate-end">{describePayload(entry.ask.payload)}</Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color={message ? (message.startsWith("failed") ? RED : posting ? YELLOW : GREEN) : MUTED} wrap="truncate-end">
          {message ?? (composing ? `describe the ask for ${repo}/${laneId} (enter: post, esc: cancel):` : `enter: view detail c: claim and start${allowPost ? "   n: post a new ask" : ""}   esc: back`)}
        </Text>
        {composing && (
          <Text wrap="truncate-start">
            {"> "}
            {draft}
            {posting ? "" : "_"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
