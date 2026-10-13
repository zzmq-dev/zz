// One Lane's own asks and their status -- what LaneList's "enter"
// pushes into (zz top's lanes tab, zz work --assist's "n"): see
// what's already queued/answered before posting a new one, and post it
// here, not from the plain list. Reads straight from the same
// LaneSnapshot[] the list itself polls (useLaneSnapshots.ts) -- no
// separate fetch, this is just a different view of data already in
// hand.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { LaneSnapshot } from "./types.js";
import type { AskEntry, AnswerEntry } from "../engine/types.js";
import { MUTED, CYAN, YELLOW, GREEN, RED } from "./theme.js";

export interface LaneDetailProps {
  repo: string;
  laneId: string;
  snapshots: LaneSnapshot[];
  maxRows: number;
  /** Who ask_post's own `from` field names -- null means not logged in, so "n" prompts to log in instead of opening the composer. */
  identity: string | null;
  onPostAsk: (repo: string, laneId: string, description: string) => Promise<void>;
  onBack: () => void;
  /** Mirrors Explore.tsx's own prop -- true while the ask-description box owns the keyboard, so the parent's own hotkeys pause the same way they do for Explore's search box. */
  onEditingChange?: (editing: boolean) => void;
}

function describePayload(payload: unknown): string {
  if (payload && typeof payload === "object" && "description" in payload) {
    const d = (payload as { description?: unknown }).description;
    if (typeof d === "string") return d;
  }
  return payload === undefined ? "" : JSON.stringify(payload);
}

function statusOf(ask: AskEntry, answers: AnswerEntry[]): { label: string; color: string } {
  const answer = answers.find((a) => a.ask === ask.id);
  if (!answer) return { label: "open", color: YELLOW };
  if (answer.action === "complete") return { label: "complete", color: GREEN };
  if (answer.action === "grant") return { label: "granted", color: GREEN };
  return { label: "denied", color: RED };
}

export function LaneDetail({ repo, laneId, snapshots, maxRows, identity, onPostAsk, onBack, onEditingChange }: LaneDetailProps) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { isRawModeSupported } = useStdin();

  const snapshot = snapshots.find((s) => s.repo === repo && s.lane.id === laneId);
  const asks = (snapshot?.lane.history.filter((e): e is AskEntry => e.type === "ASK") ?? []).slice().reverse(); // newest first
  const answers = snapshot?.lane.history.filter((e): e is AnswerEntry => e.type === "ANSWER") ?? [];

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
      if (input === "n") {
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
  const shownAsks = asks.slice(0, listRows);

  return (
    <Box flexDirection="column">
      <Text bold color={CYAN} wrap="truncate-end">
        {repo}/{laneId} -- {snapshot?.lane.status ?? "unknown"} ({asks.length} ask{asks.length === 1 ? "" : "s"})
      </Text>
      {shownAsks.length === 0 ? (
        <Text color={MUTED}>no asks in this lane yet</Text>
      ) : (
        shownAsks.map((a) => {
          const { label, color } = statusOf(a, answers);
          return (
            <Box key={a.id}>
              <Box width={16} marginRight={1} flexShrink={0}>
                <Text color={MUTED} wrap="truncate-end">
                  {a.kind}
                </Text>
              </Box>
              <Box width={10} marginRight={1} flexShrink={0}>
                <Text bold color={color} wrap="truncate-end">
                  {label}
                </Text>
              </Box>
              <Box width={20} marginRight={1} flexShrink={0}>
                <Text color={MUTED} wrap="truncate-end">
                  from {a.from}
                </Text>
              </Box>
              <Text wrap="truncate-end">{describePayload(a.payload)}</Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color={message ? (message.startsWith("failed") ? RED : posting ? YELLOW : GREEN) : MUTED} wrap="truncate-end">
          {message ?? (composing ? `describe the ask for ${repo}/${laneId} (enter: post, esc: cancel):` : "n: post a new ask   esc: back to lanes")}
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
