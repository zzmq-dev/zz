// One Lane's own asks and their status -- what LaneList's "enter"
// pushes into (zz top's lanes tab, zz work --assist's lane picker):
// see what's already queued/answered, filter by status ("s", cycled --
// same convention as LiveLog.tsx's own filter bar), post a new one
// ("n"), and view one's full detail (enter). In --assist (onViewAsk/
// onClaimAsk both given), enter hands off to AssistApp's own richer
// detail view, and "c" claims it and starts a work session right from
// the list. zz top passes neither callback -- it's a pure watcher,
// nothing to claim -- so enter there instead opens this component's
// own fallback: the ask's full JSON, pretty-printed (jsonDetail state
// below), since that's otherwise nowhere to see past describePayload's
// one-line summary.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { LaneSnapshot } from "./types.js";
import type { ClaimableEntry } from "../engine/workqueue.js";
import { claimHolder } from "../engine/workqueue.js";
import type { AskEntry, AnswerEntry } from "../engine/types.js";
import { MUTED, CYAN, PINK, YELLOW, GREEN, RED } from "./theme.js";

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

const STATUS_COLOR: Record<string, string> = { open: YELLOW, claimed: GREEN, granted: GREEN, complete: GREEN, denied: RED };

/** One label per entry regardless of mode -- the unclaimed pseudo-lane only ever has "open"/"claimed" (claimableAsks, engine/workqueue.ts, already excludes anything answered), a real lane's own history can show the full open/granted/complete/denied lifecycle. */
function statusLabel(entry: ClaimableEntry, answers: AnswerEntry[], unclaimedMode: boolean): string {
  if (unclaimedMode) return entry.alreadyClaimed ? "claimed" : "open";
  const answer = answers.find((a) => a.ask === entry.ask.id);
  if (!answer) return "open";
  if (answer.action === "complete") return "complete";
  if (answer.action === "grant") return "granted";
  return "denied";
}

function cycle<T>(values: T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

export function LaneDetail({ repo, laneId, snapshots, maxRows, identity, onPostAsk, onBack, onEditingChange, claimableEntries, onViewAsk, onClaimAsk, allowPost = true }: LaneDetailProps) {
  const [cursor, setCursor] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // zz top has no onViewAsk (it's a pure watcher, nothing to claim) --
  // "enter" there opens this instead: the ask's own full JSON, pretty-
  // printed, since describePayload's one-line summary above is the
  // only other place its payload ever shows up. `zz work --assist`
  // still gets its own onViewAsk behavior unchanged when that prop IS
  // given (see the "enter" handler below) -- this is purely the
  // no-callback fallback, not a replacement for it.
  const [jsonDetail, setJsonDetail] = useState<ClaimableEntry | null>(null);
  const [jsonScroll, setJsonScroll] = useState(0);
  const { isRawModeSupported } = useStdin();

  const snapshot = snapshots.find((s) => s.repo === repo && s.lane.id === laneId);
  const unclaimedMode = claimableEntries !== undefined;
  // Unified shape regardless of mode: a real lane's own history gets
  // wrapped into the same ClaimableEntry shape the unclaimed pseudo-
  // lane already comes in, so selection/view/claim never need to
  // branch on which mode produced a given row.
  const allEntries: ClaimableEntry[] = unclaimedMode
    ? claimableEntries
    : (snapshot?.lane.history.filter((e): e is AskEntry => e.type === "ASK") ?? [])
        .slice()
        .reverse() // newest first
        .map((a) => ({ repo, laneId, ask: a, alreadyClaimed: snapshot ? claimHolder(snapshot.lane, a.id) === identity : false }));
  const answers = unclaimedMode ? [] : (snapshot?.lane.history.filter((e): e is AnswerEntry => e.type === "ANSWER") ?? []);

  const statuses = ["all", ...Array.from(new Set(allEntries.map((e) => statusLabel(e, answers, unclaimedMode))))];
  const entries = statusFilter === "all" ? allEntries : allEntries.filter((e) => statusLabel(e, answers, unclaimedMode) === statusFilter);

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
      if (jsonDetail) {
        if (key.escape) {
          setJsonDetail(null);
          setJsonScroll(0);
          return;
        }
        if (key.upArrow) setJsonScroll((s) => Math.max(0, s - 1));
        if (key.downArrow) setJsonScroll((s) => s + 1);
        return;
      }
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
      if (input === "s") {
        setStatusFilter((v) => cycle(statuses, statuses.includes(v) ? v : "all"));
        setCursor(0);
        return;
      }
      if (key.return) {
        const entry = entries[cursor];
        if (!entry) return;
        if (onViewAsk) onViewAsk(entry);
        else setJsonDetail(entry);
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

  if (jsonDetail) {
    const lines = JSON.stringify(jsonDetail.ask, null, 2).split("\n");
    const bodyRows = Math.max(1, maxRows - 2);
    const maxScroll = Math.max(0, lines.length - bodyRows);
    const scroll = Math.min(jsonScroll, maxScroll);
    const shownLines = lines.slice(scroll, scroll + bodyRows);
    return (
      <Box flexDirection="column">
        <Text bold color={CYAN} wrap="truncate-end">
          {jsonDetail.ask.id} ({jsonDetail.ask.kind})
        </Text>
        {shownLines.map((line, i) => (
          <Text key={scroll + i} wrap="truncate-end">
            {line}
          </Text>
        ))}
        <Box marginTop={1}>
          <Text color={MUTED} wrap="truncate-end">
            {lines.length > bodyRows ? `line ${scroll + 1}-${Math.min(scroll + bodyRows, lines.length)} of ${lines.length}   ` : ""}
            up/down: scroll   esc: back
          </Text>
        </Box>
      </Box>
    );
  }

  const listRows = Math.max(1, maxRows - 2);
  const windowStart = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), Math.max(0, entries.length - listRows)));
  const shownEntries = entries.slice(windowStart, windowStart + listRows);

  return (
    <Box flexDirection="column">
      <Text bold color={CYAN} wrap="truncate-end">
        {unclaimedMode ? "unclaimed across all watched repos" : `${repo}/${laneId} -- ${snapshot?.lane.status ?? "unknown"}`}
      </Text>
      <Text color={MUTED} wrap="truncate-end">
        filter: status=[<Text color={statusFilter === "all" ? MUTED : PINK}>{statusFilter}</Text>](s) -- {entries.length} of {allEntries.length} ask{allEntries.length === 1 ? "" : "s"}
      </Text>
      {shownEntries.length === 0 ? (
        <Text color={MUTED}>{allEntries.length === 0 ? (unclaimedMode ? "nothing claimable right now" : "no asks in this lane yet") : "(nothing matches this filter)"}</Text>
      ) : (
        shownEntries.map((entry, i) => {
          const idx = windowStart + i;
          const current = idx === cursor;
          const label = statusLabel(entry, answers, unclaimedMode);
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
                <Text bold color={STATUS_COLOR[label] ?? MUTED} wrap="truncate-end">
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
          {message ??
            (composing
              ? `describe the ask for ${repo}/${laneId} (enter: post, esc: cancel):`
              : ["enter: view detail", onClaimAsk && "c: claim and start", "s: filter by status", allowPost && "n: post a new ask", "esc: back"].filter(Boolean).join("   "))}
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
