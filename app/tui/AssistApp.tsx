// `zz work --assist`'s TUI: pick a claimable work/changeset_review ask
// out of the repos you're watching, then chat with the model about its
// draft (or, for a review, its recommendation) before explicitly
// submitting it back into the protocol as a real ANSWER -- a
// human-in-the-loop counterpart to `zz work`'s own fully autonomous
// claim-draft-verify-submit loop, not a replacement for it. Nothing is
// cloned until an ask is actually picked (proposeContributorWork's own
// shard-clone step handles that, same as the autonomous path); the
// picker itself only ever reads lane_list across the watched repos.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { claimableAcrossRepos, type WorkScope, type ClaimableEntry } from "../engine/workqueue.js";
import type { ChatBackend } from "../agent/chatBackend.js";
import {
  proposeContributorWork,
  acceptContributorWork,
  reviseContributorWork,
  denyContributorWork,
  proposeReview,
  acceptReview,
  discussReview,
  type ContributorProposal,
  type ReviewProposal,
  type ScriptedFlowOptions,
} from "../agent/scriptedWork.js";
import { remoteCallTool } from "../cli/lib/remoteTools.js";
import type { ResolvedRepo } from "../cli/lib/repo.js";
import type { RepoWatchStore } from "../cli/lib/watchedRepos.js";
import { BACKDROP, PANEL, BORDER, MUTED, CYAN, YELLOW, GREEN, RED } from "./theme.js";
import { useTerminalSize } from "./useTerminalSize.js";

export interface AssistAppProps {
  watch: RepoWatchStore;
  agent: string;
  scope: WorkScope;
  useRemote: boolean;
  backend: ChatBackend;
  modeRun: <T>(fn: () => Promise<T>) => Promise<T>;
  authedCloneUrlFor?: (slug: string) => string;
  onExit: () => Promise<void>;
}

interface TranscriptEntry {
  role: "assistant" | "user" | "system";
  content: string;
}

function describeAsk(ask: ClaimableEntry["ask"]): string {
  const payload = ask.payload as { description?: string; taskDescription?: string } | undefined;
  return (payload?.description ?? payload?.taskDescription ?? JSON.stringify(ask.payload)).slice(0, 90);
}

function formatProposal(p: ContributorProposal["proposal"]): string {
  const filesBlock = p.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  return `${p.summary}\n(commit message: "${p.message}")\n\n${filesBlock}`;
}

function formatDecision(d: ReviewProposal): string {
  return `Decision: ${d.decision}\nReason: ${d.reason}`;
}

const MAX_ENTRY_LINES = 30;
const MAX_VISIBLE_ENTRIES = 4;

function truncateLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_ENTRY_LINES) return text;
  return [...lines.slice(0, MAX_ENTRY_LINES), `... (${lines.length - MAX_ENTRY_LINES} more lines)`].join("\n");
}

export function AssistApp(props: AssistAppProps): React.ReactElement {
  const { watch, agent, scope, useRemote, backend, modeRun, authedCloneUrlFor, onExit } = props;
  const { columns } = useTerminalSize();
  const [phase, setPhase] = useState<"picking" | "session">("picking");
  const [claimableList, setClaimableList] = useState<ClaimableEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ClaimableEntry | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const flowOptsRef = useRef<ScriptedFlowOptions | null>(null);
  const workResultRef = useRef<ContributorProposal | null>(null);
  const reviewResultRef = useRef<ReviewProposal | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  transcriptRef.current = transcript;

  const reposKey = watch
    .get()
    .map((r) => r.slug)
    .join(",");

  // Picker polling -- claimableAcrossRepos itself (engine/workqueue.ts)
  // already encodes exactly the same scope/claim-holder rules the real
  // `zz work` loop obeys, so this reuses it verbatim (wrapped in
  // modeRun for correct remote backend scoping) instead of re-deriving
  // the same logic by hand against raw lane_list reads.
  useEffect(() => {
    if (phase !== "picking") return;
    let cancelled = false;
    const read = async () => {
      try {
        const repos = watch.get().map((r) => ({ repo: r.slug }));
        const next = await modeRun(() => claimableAcrossRepos(repos, agent, scope));
        if (!cancelled) setClaimableList(next.filter((c) => c.ask.kind === "work" || c.ask.kind === "changeset_review"));
      } catch {
        // transient (a repo not reachable yet, a network blip) -- keep showing the last good list
      }
    };
    read();
    const id = setInterval(read, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, agent, scope, reposKey]);

  useEffect(() => {
    if (cursor >= claimableList.length) setCursor(Math.max(0, claimableList.length - 1));
  }, [claimableList, cursor]);

  // Session driver -- runs once when an ask is picked: builds this
  // ask's ScriptedFlowOptions, then drafts the first proposal/decision.
  // Never clones anything itself -- proposeContributorWork's own
  // shard-clone step (remote mode) handles that exactly when needed;
  // local mode's repos are already on disk by the time they're
  // watchable at all.
  useEffect(() => {
    if (phase !== "session" || !selected) return;
    let cancelled = false;
    const resolvedParent = watch.get().find((r) => r.slug === selected.repo) as ResolvedRepo;
    const flowOpts: ScriptedFlowOptions = {
      resolved: resolvedParent,
      laneId: selected.laneId,
      theAsk: selected.ask,
      agent,
      alreadyClaimed: selected.alreadyClaimed,
      backend,
      onLog: (line) => {
        if (!cancelled) setStatus(line);
      },
      callTool: useRemote ? remoteCallTool : undefined,
      authedCloneUrlFor,
      onShardReady: (repo) => watch.add(repo),
    };
    flowOptsRef.current = flowOpts;
    workResultRef.current = null;
    reviewResultRef.current = null;
    setTranscript([]);
    setDone(false);
    setBusy(true);

    (async () => {
      try {
        if (selected.ask.kind === "work") {
          setStatus("drafting...");
          const res = await modeRun(() => proposeContributorWork(flowOpts));
          if (cancelled) return;
          if (!res.ok) {
            setTranscript((t) => [...t, { role: "assistant", content: `Couldn't produce a verified draft: ${res.denialReason}` }]);
            setStatus("type feedback to try again, /deny [reason], or esc to cancel");
          } else {
            workResultRef.current = res.result;
            setTranscript((t) => [...t, { role: "assistant", content: formatProposal(res.result.proposal) }]);
            setStatus("type feedback, /submit, /deny [reason], or esc to cancel");
          }
        } else {
          setStatus("drafting a recommendation...");
          const proposal = await modeRun(() => proposeReview(flowOpts));
          if (cancelled) return;
          reviewResultRef.current = proposal;
          setTranscript((t) => [...t, { role: "assistant", content: formatDecision(proposal) }]);
          setStatus("ask questions, /approve [reason], /request-changes [reason], or esc to cancel");
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setTranscript((t) => [...t, { role: "system", content: `Error: ${message}` }]);
          setStatus("esc to go back");
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, selected]);

  async function handleCommand(cmd: string, arg: string): Promise<void> {
    const flowOpts = flowOptsRef.current;
    if (!flowOpts || !selected) return;
    if (cmd === "cancel") {
      setPhase("picking");
      setSelected(null);
      return;
    }
    if (selected.ask.kind === "work") {
      if (cmd === "submit" && workResultRef.current) {
        setBusy(true);
        setStatus("submitting...");
        await modeRun(() => acceptContributorWork(flowOpts, workResultRef.current!));
        setStatus("submitted for review.");
        setDone(true);
        setBusy(false);
        return;
      }
      if (cmd === "deny") {
        setBusy(true);
        setStatus("denying...");
        await modeRun(() => denyContributorWork(flowOpts, arg || "rejected by human"));
        setStatus("denied.");
        setDone(true);
        setBusy(false);
        return;
      }
      setTranscript((t) => [...t, { role: "system", content: `Unknown command "/${cmd}". Try /submit, /deny [reason], or /cancel.` }]);
      return;
    }
    if ((cmd === "approve" || cmd === "request-changes") && reviewResultRef.current) {
      const decision = cmd === "approve" ? ("approve" as const) : ("request_changes" as const);
      setBusy(true);
      setStatus(cmd === "approve" ? "approving..." : "requesting changes...");
      await modeRun(() => acceptReview(flowOpts, { decision, reason: arg || reviewResultRef.current!.reason }));
      setStatus(cmd === "approve" ? "approved." : "requested changes.");
      setDone(true);
      setBusy(false);
      return;
    }
    setTranscript((t) => [...t, { role: "system", content: `Unknown command "/${cmd}". Try /approve [reason], /request-changes [reason], or /cancel.` }]);
  }

  async function handleFeedback(text: string): Promise<void> {
    const flowOpts = flowOptsRef.current;
    if (!flowOpts || !selected) return;
    setTranscript((t) => [...t, { role: "user", content: text }]);
    setBusy(true);
    if (selected.ask.kind === "work") {
      if (!workResultRef.current) {
        setStatus("retrying from scratch...");
        const res = await modeRun(() => proposeContributorWork(flowOpts));
        if (!res.ok) {
          setTranscript((t) => [...t, { role: "assistant", content: `Still couldn't produce a verified draft: ${res.denialReason}` }]);
          setStatus("type feedback to try again, /deny [reason], or esc to cancel");
        } else {
          workResultRef.current = res.result;
          setTranscript((t) => [...t, { role: "assistant", content: formatProposal(res.result.proposal) }]);
          setStatus("type feedback, /submit, /deny [reason], or esc to cancel");
        }
      } else {
        setStatus("revising...");
        const res = await modeRun(() => reviseContributorWork(flowOpts, workResultRef.current!, text));
        if (!res.ok) {
          setTranscript((t) => [...t, { role: "assistant", content: `Couldn't produce a verified revision: ${res.denialReason}` }]);
        } else {
          workResultRef.current = res.result;
          setTranscript((t) => [...t, { role: "assistant", content: formatProposal(res.result.proposal) }]);
        }
        setStatus("type feedback, /submit, /deny [reason], or esc to cancel");
      }
    } else {
      setStatus("thinking...");
      const conversation = transcriptRef.current.map((e) => ({ role: e.role === "user" ? ("user" as const) : ("assistant" as const), content: e.content }));
      const answer = await modeRun(() => discussReview(flowOpts, conversation, text));
      setTranscript((t) => [...t, { role: "assistant", content: answer }]);
      setStatus("ask questions, /approve [reason], /request-changes [reason], or esc to cancel");
    }
    setBusy(false);
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      void onExit().then(() => process.exit(0));
      return;
    }
    if (phase === "picking") {
      if (input === "q") {
        void onExit().then(() => process.exit(0));
        return;
      }
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(claimableList.length - 1, c + 1));
      else if (key.return && claimableList[cursor]) {
        setSelected(claimableList[cursor]);
        setPhase("session");
      }
      return;
    }
    // session phase
    if (done) {
      if (key.return || key.escape) {
        setPhase("picking");
        setSelected(null);
        setDone(false);
      }
      return;
    }
    if (busy) return;
    if (key.escape) {
      setPhase("picking");
      setSelected(null);
      return;
    }
    if (key.return) {
      const text = inputValue.trim();
      setInputValue("");
      if (!text) return;
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(" ");
        void handleCommand(cmd, rest.join(" ").trim());
      } else {
        void handleFeedback(text);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInputValue((v) => v.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setInputValue((v) => v + input);
    }
  });

  if (phase === "picking") {
    return (
      <Box flexDirection="column" width={columns} minHeight={10} backgroundColor={BACKDROP} paddingX={1}>
        <Text color={CYAN} bold>
          zz work --assist -- pick an ask
        </Text>
        <Box marginTop={1} flexDirection="column">
          {claimableList.length === 0 ? (
            <Text color={MUTED}>No claimable work/changeset_review asks right now across your watched repos. (refreshing every 2s)</Text>
          ) : (
            claimableList.map((c, i) => (
              <Text key={c.ask.id} color={i === cursor ? CYAN : undefined}>
                {i === cursor ? "> " : "  "}
                <Text color={c.ask.kind === "work" ? YELLOW : GREEN}>[{c.ask.kind}]</Text> {c.repo} -- {describeAsk(c.ask)}
                {c.alreadyClaimed ? " (claimed by you)" : ""}
              </Text>
            ))
          )}
        </Box>
        <Box marginTop={1}>
          <Text color={MUTED}>↑/↓ select enter: start q/ctrl+c: quit</Text>
        </Box>
      </Box>
    );
  }

  const visible = transcript.slice(-MAX_VISIBLE_ENTRIES);
  const hiddenCount = transcript.length - visible.length;

  return (
    <Box flexDirection="column" width={columns} minHeight={10} backgroundColor={BACKDROP} paddingX={1}>
      <Text color={CYAN} bold>
        {selected?.ask.kind} {selected?.ask.id} in {selected?.repo}/{selected?.laneId}
      </Text>
      <Text color={MUTED}>{selected ? describeAsk(selected.ask) : ""}</Text>
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={BORDER} backgroundColor={PANEL} paddingX={1}>
        {hiddenCount > 0 && <Text color={MUTED}>... {hiddenCount} earlier turn(s) not shown ...</Text>}
        {visible.map((e, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text color={e.role === "user" ? CYAN : e.role === "system" ? RED : GREEN} bold>
              {e.role === "user" ? "you" : e.role === "system" ? "system" : "model"}:
            </Text>
            <Text>{truncateLines(e.content)}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={busy ? YELLOW : MUTED}>{status}</Text>
      </Box>
      {!done && (
        <Box marginTop={1}>
          <Text color={MUTED}>{"> "}</Text>
          <Text>{inputValue}</Text>
          <Text color={MUTED}>{busy ? "" : "_"}</Text>
        </Box>
      )}
      {done && <Text color={MUTED}>enter/esc: back to the ask list</Text>}
    </Box>
  );
}
