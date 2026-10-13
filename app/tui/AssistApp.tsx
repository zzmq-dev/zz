// `zz work --assist`'s interface: pick a claimable work/changeset_review
// ask out of the repos you're watching, then chat with the model about
// its draft (or, for a review, its recommendation) before explicitly
// submitting it back into the protocol as a real ANSWER -- a
// human-in-the-loop counterpart to `zz work`'s own fully autonomous
// claim-draft-verify-submit loop, not a replacement for it.
//
// Deliberately NOT a full-screen/alt-buffer dashboard (see
// cli/commands/workAssist.ts, which never calls enterFullscreen) --
// the chat transcript renders via ink's own <Static>, which prints
// permanently into the terminal's real scrollback and is never
// re-rendered once written. That's what makes scrolling back through
// earlier turns just work (your terminal's own scrollback, not a
// bespoke one this app would otherwise have to build), and it's the
// same shape Claude Code's own CLI uses. Only the "current turn in
// progress" region below the transcript re-renders on every state
// change (streaming tokens, the input box).
//
// Nothing is cloned until an ask is actually picked
// (proposeContributorWork's own shard-clone step handles that, same as
// the autonomous path); the picker itself only ever reads lane_list
// across the watched repos.
import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import { claimableAcrossRepos, type WorkScope, type ClaimableEntry } from "../engine/workqueue.js";
import type { ChatBackend } from "../agent/chatBackend.js";
import {
  proposeContributorWork,
  acceptContributorWork,
  reviseContributorWork,
  commitContributorWork,
  denyContributorWork,
  releaseAsk,
  proposeReview,
  acceptReview,
  discussReview,
  type ContributorProposal,
  type ReviewProposal,
  type ScriptedFlowOptions,
} from "../agent/scriptedWork.js";
import { remoteCallTool } from "../cli/lib/remoteTools.js";
import { diffFileSets } from "../cli/lib/fileDiff.js";
import type { ResolvedRepo } from "../cli/lib/repo.js";
import type { RepoWatchStore } from "../cli/lib/watchedRepos.js";
import { MUTED, CYAN, YELLOW, GREEN, RED } from "./theme.js";

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
  return payload?.description ?? payload?.taskDescription ?? JSON.stringify(ask.payload);
}

function formatFreshProposal(p: ContributorProposal["proposal"]): string {
  const filesBlock = p.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  return `${p.summary}\n(commit message: "${p.message}")\n\n${filesBlock}`;
}

function formatRevisedProposal(previous: ContributorProposal["proposal"], p: ContributorProposal["proposal"]): string {
  const diff = diffFileSets(previous.files, p.files);
  return `${p.summary}\n(commit message: "${p.message}")\n\n${diff || "(no file changes)"}`;
}

function formatDecision(d: ReviewProposal): string {
  return `Decision: ${d.decision}\nReason: ${d.reason}`;
}

const roleLabel: Record<TranscriptEntry["role"], string> = { assistant: "model", user: "you", system: "system" };
const roleColor: Record<TranscriptEntry["role"], string> = { assistant: GREEN, user: CYAN, system: RED };

export function AssistApp(props: AssistAppProps): React.ReactElement {
  const { watch, agent, scope, useRemote, backend, modeRun, authedCloneUrlFor, onExit } = props;
  const [phase, setPhase] = useState<"picking" | "session">("picking");
  const [claimableList, setClaimableList] = useState<ClaimableEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ClaimableEntry | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [liveLabel, setLiveLabel] = useState("");
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const flowOptsRef = useRef<ScriptedFlowOptions | null>(null);
  const workResultRef = useRef<ContributorProposal | null>(null);
  const reviewResultRef = useRef<ReviewProposal | null>(null);
  const entriesRef = useRef<TranscriptEntry[]>([]);
  entriesRef.current = entries;

  const reposKey = watch
    .get()
    .map((r) => r.slug)
    .join(",");

  function pushEntry(role: TranscriptEntry["role"], content: string): void {
    setEntries((e) => [...e, { role, content }]);
  }

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
  // watchable at all. ensureShard (worker/src/webApp.ts) is
  // deterministic/idempotent per task, so re-picking an already-claimed
  // ask reuses the same shard rather than creating a new one -- this is
  // what makes "pause (leave it claimed), come back later" safe: a
  // /commit before pausing is real git history in that same shard.
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
      onPartial: (text) => {
        if (!cancelled) setLiveText(text);
      },
      callTool: useRemote ? remoteCallTool : undefined,
      authedCloneUrlFor,
      onShardReady: (repo) => watch.add(repo),
    };
    flowOptsRef.current = flowOpts;
    workResultRef.current = null;
    reviewResultRef.current = null;
    setEntries(selected.alreadyClaimed ? [{ role: "system", content: "Resuming -- you already hold this claim. Drafting against the current state of your shard." }] : []);
    setLiveLabel("");
    setLiveText("");
    setDone(false);
    setBusy(true);

    (async () => {
      try {
        if (selected.ask.kind === "work") {
          setLiveLabel("drafting");
          setStatus("drafting...");
          const res = await modeRun(() => proposeContributorWork(flowOpts));
          if (cancelled) return;
          setLiveLabel("");
          setLiveText("");
          if (!res.ok) {
            pushEntry("assistant", `Couldn't produce a verified draft: ${res.denialReason}`);
            setStatus("type feedback to try again, /deny [reason], /release, or esc to pause");
          } else {
            workResultRef.current = res.result;
            pushEntry("assistant", formatFreshProposal(res.result.proposal));
            setStatus("type feedback, /submit, /commit, /deny [reason], /release, or esc to pause");
          }
        } else {
          setLiveLabel("thinking");
          setStatus("drafting a recommendation...");
          const proposal = await modeRun(() => proposeReview(flowOpts));
          if (cancelled) return;
          setLiveLabel("");
          setLiveText("");
          reviewResultRef.current = proposal;
          pushEntry("assistant", formatDecision(proposal));
          setStatus("ask questions, /approve [reason], /request-changes [reason], /release, or esc to pause");
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          pushEntry("system", `Error: ${message}`);
          setStatus("esc to go back");
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
          setLiveLabel("");
          setLiveText("");
        }
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
      pushEntry("system", "Paused -- still claimed. Pick it again any time to resume.");
      setPhase("picking");
      setSelected(null);
      return;
    }
    if (cmd === "release") {
      setBusy(true);
      setStatus("releasing...");
      await modeRun(() => releaseAsk(flowOpts));
      pushEntry("system", "Released -- claimable by anyone again.");
      setStatus("");
      setDone(true);
      setBusy(false);
      return;
    }

    if (selected.ask.kind === "work") {
      if (cmd === "submit" && workResultRef.current) {
        setBusy(true);
        setStatus("submitting...");
        await modeRun(() => acceptContributorWork(flowOpts, workResultRef.current!));
        pushEntry("system", "Submitted for review.");
        setStatus("");
        setDone(true);
        setBusy(false);
        return;
      }
      if (cmd === "commit" && workResultRef.current) {
        if (!authedCloneUrlFor) {
          pushEntry("system", "Local mode has no shard to commit to independently -- /submit when ready.");
          return;
        }
        setBusy(true);
        setStatus("committing...");
        const committed = await modeRun(() => commitContributorWork(flowOpts, workResultRef.current!));
        workResultRef.current = committed;
        pushEntry("system", `Committed ${committed.shardSource?.commitOid.slice(0, 10)} to the shard. Still claimed -- /submit when ready, or pause (esc) and come back any time; this is saved.`);
        setStatus("type feedback, /submit, /commit, /deny [reason], /release, or esc to pause");
        setBusy(false);
        return;
      }
      if (cmd === "deny") {
        setBusy(true);
        setStatus("denying...");
        await modeRun(() => denyContributorWork(flowOpts, arg || "rejected by human"));
        pushEntry("system", "Denied.");
        setStatus("");
        setDone(true);
        setBusy(false);
        return;
      }
      pushEntry("system", `Unknown command "/${cmd}". Try /submit, /commit, /deny [reason], /release, or /cancel.`);
      return;
    }

    if ((cmd === "approve" || cmd === "request-changes") && reviewResultRef.current) {
      const decision = cmd === "approve" ? ("approve" as const) : ("request_changes" as const);
      setBusy(true);
      setStatus(cmd === "approve" ? "approving..." : "requesting changes...");
      await modeRun(() => acceptReview(flowOpts, { decision, reason: arg || reviewResultRef.current!.reason }));
      pushEntry("system", cmd === "approve" ? "Approved." : "Requested changes.");
      setStatus("");
      setDone(true);
      setBusy(false);
      return;
    }
    pushEntry("system", `Unknown command "/${cmd}". Try /approve [reason], /request-changes [reason], /release, or /cancel.`);
  }

  async function handleFeedback(text: string): Promise<void> {
    const flowOpts = flowOptsRef.current;
    if (!flowOpts || !selected) return;
    pushEntry("user", text);
    setBusy(true);
    if (selected.ask.kind === "work") {
      if (!workResultRef.current) {
        setLiveLabel("drafting");
        setStatus("retrying from scratch...");
        const res = await modeRun(() => proposeContributorWork(flowOpts));
        setLiveLabel("");
        setLiveText("");
        if (!res.ok) {
          pushEntry("assistant", `Still couldn't produce a verified draft: ${res.denialReason}`);
          setStatus("type feedback to try again, /deny [reason], /release, or esc to pause");
        } else {
          workResultRef.current = res.result;
          pushEntry("assistant", formatFreshProposal(res.result.proposal));
          setStatus("type feedback, /submit, /commit, /deny [reason], /release, or esc to pause");
        }
      } else {
        const previous = workResultRef.current.proposal;
        setLiveLabel("revising");
        setStatus("revising...");
        const res = await modeRun(() => reviseContributorWork(flowOpts, workResultRef.current!, text));
        setLiveLabel("");
        setLiveText("");
        if (!res.ok) {
          pushEntry("assistant", `Couldn't produce a verified revision: ${res.denialReason}`);
        } else {
          workResultRef.current = res.result;
          pushEntry("assistant", formatRevisedProposal(previous, res.result.proposal));
        }
        setStatus("type feedback, /submit, /commit, /deny [reason], /release, or esc to pause");
      }
    } else {
      setLiveLabel("thinking");
      setStatus("thinking...");
      const conversation = entriesRef.current.filter((e) => e.role !== "system").map((e) => ({ role: e.role === "user" ? ("user" as const) : ("assistant" as const), content: e.content }));
      const answer = await modeRun(() => discussReview(flowOpts, conversation, text));
      setLiveLabel("");
      setLiveText("");
      pushEntry("assistant", answer);
      setStatus("ask questions, /approve [reason], /request-changes [reason], /release, or esc to pause");
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
      pushEntry("system", "Paused -- still claimed. Pick it again any time to resume.");
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
      <Box flexDirection="column">
        <Text color={CYAN} bold>
          zz work --assist -- pick an ask
        </Text>
        <Box marginTop={1} flexDirection="column">
          {claimableList.length === 0 ? (
            <Text color={MUTED}>No claimable work/changeset_review asks right now across your watched repos. (refreshing every 2s)</Text>
          ) : (
            claimableList.map((c, i) => (
              <Box key={c.ask.id} flexDirection="column" marginBottom={1}>
                <Text color={i === cursor ? CYAN : undefined}>
                  {i === cursor ? "> " : "  "}
                  <Text color={c.ask.kind === "work" ? YELLOW : GREEN}>[{c.ask.kind}]</Text> {c.repo}
                  {c.alreadyClaimed ? " (claimed by you)" : ""}
                </Text>
                <Text color={i === cursor ? undefined : MUTED}>{"    " + describeAsk(c.ask)}</Text>
              </Box>
            ))
          )}
        </Box>
        <Text color={MUTED}>↑/↓ select enter: start q/ctrl+c: quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(e, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text color={roleColor[e.role]} bold>
              {roleLabel[e.role]}:
            </Text>
            <Text>{e.content}</Text>
          </Box>
        )}
      </Static>
      <Box flexDirection="column" marginBottom={1}>
        <Text color={CYAN} bold>
          {selected?.ask.kind} {selected?.ask.id} in {selected?.repo}/{selected?.laneId}
        </Text>
        <Text color={MUTED}>{selected ? describeAsk(selected.ask) : ""}</Text>
      </Box>
      {liveText && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={YELLOW} bold>
            {liveLabel}:
          </Text>
          <Text>{liveText}</Text>
        </Box>
      )}
      <Text color={busy ? YELLOW : MUTED}>{status}</Text>
      {!done && (
        <Box>
          <Text color={MUTED}>{"> "}</Text>
          <Text>{inputValue}</Text>
          <Text color={MUTED}>{busy ? "" : "_"}</Text>
        </Box>
      )}
      {done && <Text color={MUTED}>enter/esc: back to the ask list</Text>}
    </Box>
  );
}
