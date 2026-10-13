// Every Lane across the repos being watched, its status, and its
// coordinators -- the "overview" building block shared by `zz work` and
// `zz top`. Read-only by default: scrolling (up/down, Page Up/Down,
// Home/End) is handled by the parent TabView, which passes down the
// resulting offset, scrolling from the top of the list rather than
// following a live tail.
//
// Passing onPostAsk switches this into an interactive picker instead
// (zz top's own lanes tab): arrow keys move a selection cursor (not
// just scroll -- the cursor following its own window, same convention
// AssistApp's ask picker uses, rather than TabView's parent-driven
// scrollOffset, which this mode ignores entirely, same as Explore.tsx
// already does for its own repo list), and "n" starts composing a
// plain-text description to post as a new "work" ask into the
// selected lane.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { LaneSnapshot } from "./types.js";
import { STATUS_COLOR, MUTED, PINK, CYAN, YELLOW, GREEN } from "./theme.js";

export interface LaneListProps {
  snapshots: LaneSnapshot[];
  maxRows: number;
  scrollOffset: number;
  /** Provide to make the list interactive (zz top's own lanes tab); omit for a purely read-only view (zz work's own tab, unchanged). Posts a "work" ask (payload.description) into the given repo/lane. */
  onPostAsk?: (repo: string, laneId: string, description: string) => Promise<void>;
  /** Who ask_post's own `from` field names -- null means not logged in, so "n" prompts to log in (the "l" hotkey, see TopApp.tsx) instead of opening the composer. */
  identity?: string | null;
  /** Mirrors Explore.tsx's own prop -- true while the ask-description box owns the keyboard, so TabView's own hotkeys (tab-switch, quit, y) pause the same way they do for Explore's search box. */
  onEditingChange?: (editing: boolean) => void;
}

export function LaneList({ snapshots, maxRows, scrollOffset, onPostAsk, identity, onEditingChange }: LaneListProps) {
  const interactive = !!onPostAsk;
  const [cursor, setCursor] = useState(0);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { isRawModeSupported } = useStdin();

  useEffect(() => {
    if (cursor >= snapshots.length) setCursor(Math.max(0, snapshots.length - 1));
  }, [snapshots.length, cursor]);

  useEffect(() => {
    onEditingChange?.(composing);
  }, [composing, onEditingChange]);

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => setMessage(null), 2500);
    return () => clearTimeout(id);
  }, [message]);

  useInput(
    (input, key) => {
      if (!interactive) return;
      if (composing) {
        if (key.escape) {
          setComposing(false);
          setDraft("");
          return;
        }
        if (key.return) {
          const text = draft.trim();
          if (!text || busy) return;
          const target = snapshots[cursor];
          if (!target) return;
          setBusy(true);
          onPostAsk!(target.repo, target.lane.id, text)
            .then(() => {
              setMessage(`posted to ${target.repo}/${target.lane.id}`);
              setComposing(false);
              setDraft("");
              setBusy(false);
            })
            .catch((err) => {
              setMessage(`failed: ${err instanceof Error ? err.message : String(err)}`);
              setBusy(false);
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
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(snapshots.length - 1, c + 1));
      else if (input === "n") {
        if (!identity) {
          setMessage("log in first (l)");
          return;
        }
        if (snapshots[cursor]) setComposing(true);
      }
    },
    { isActive: isRawModeSupported },
  );

  // Interactive mode manages its own scroll window (centered on the
  // cursor), same reasoning as AssistApp's own picker: the parent's
  // scrollOffset has no way to know about a cursor it doesn't control.
  const windowSize = Math.max(1, maxRows - 1);
  const windowStart = interactive ? Math.max(0, Math.min(cursor - Math.floor(windowSize / 2), Math.max(0, snapshots.length - windowSize))) : Math.min(scrollOffset, Math.max(0, snapshots.length - windowSize));
  const shown = snapshots.slice(windowStart, windowStart + windowSize);

  return (
    <Box flexDirection="column">
      <Text color={MUTED}>
        {snapshots.length === 0 ? "no lanes yet" : `showing ${windowStart + 1}-${windowStart + shown.length} of ${snapshots.length}`}
        {interactive && !composing && message === null ? "   n: post an ask into the selected lane" : ""}
      </Text>
      {shown.map(({ repo, lane }, i) => {
        const idx = windowStart + i;
        const current = interactive && idx === cursor;
        return (
          <Box key={`${repo}/${lane.id}`}>
            <Box flexShrink={0}>
              <Text color={current ? CYAN : undefined} bold={current}>
                {current ? "> " : "  "}
              </Text>
            </Box>
            <Box width={28} marginRight={1} flexShrink={0}>
              <Text color={current ? CYAN : MUTED} bold={current} wrap="truncate-end">
                {repo}
              </Text>
            </Box>
            <Box width={24} marginRight={1} flexShrink={0}>
              <Text bold color={current ? CYAN : PINK} wrap="truncate-end">
                {lane.id}
              </Text>
            </Box>
            <Box width={12} marginRight={1} flexShrink={0}>
              <Text bold color={STATUS_COLOR[lane.status] ?? MUTED} wrap="truncate-end">
                {lane.status}
              </Text>
            </Box>
            <Text color={MUTED} wrap="truncate-end">
              coord: {lane.coordinators.join(", ")}
            </Text>
          </Box>
        );
      })}
      {interactive && (
        <Box marginTop={1} flexDirection="column">
          <Text color={message ? (message.startsWith("failed") ? YELLOW : GREEN) : MUTED} wrap="truncate-end">
            {message ?? (composing ? `describe the ask for ${snapshots[cursor]?.repo}/${snapshots[cursor]?.lane.id} (enter: post, esc: cancel):` : "")}
          </Text>
          {composing && (
            <Text wrap="truncate-start">
              {"> "}
              {draft}
              {busy ? "" : "_"}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
