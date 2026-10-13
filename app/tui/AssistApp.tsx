// `zz work --assist`'s interface: pick a claimable work/changeset_review
// ask out of the repos you're watching, then chat with the model about
// its draft (or, for a review, its recommendation) before explicitly
// submitting it back into the protocol as a real ANSWER -- a
// human-in-the-loop counterpart to `zz work`'s own fully autonomous
// claim-draft-verify-submit loop, not a replacement for it.
//
// A real full-screen frame (cli/commands/workAssist.ts calls
// enterFullscreen, same as `zz top`/`zz work`'s own TUIs), not a plain
// scrolling CLI session -- but the transcript still needs to scroll
// back through earlier turns, which an alt-screen app can't get from
// the terminal's own scrollback (there isn't one in the alternate
// buffer). So this owns its own scroll offset exactly the way
// TabView.tsx's content panes do: flatten the transcript into lines,
// window it by `scroll`, and let arrows/Page Up/Down/Home/End/mouse
// wheel move that offset (see useMouse.ts) -- deliberately never j/k,
// unlike TabView's own read-only panes, since those are free characters
// in a chat message here.
//
// Nothing is cloned until an ask is actually picked
// (proposeContributorWork's own shard-clone step handles that, same as
// the autonomous path); the picker itself only ever reads lane_list
// across the watched repos.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { claimableAcrossRepos, type WorkScope, type ClaimableEntry } from "../engine/workqueue.js";
import type { ChatBackend } from "../agent/chatBackend.js";
import {
  proposeContributorWork,
  acceptContributorWork,
  reviseContributorWork,
  commitContributorWork,
  denyContributorWork,
  releaseAsk,
  prepareReviewWorkspace,
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
import { useTerminalSize } from "./useTerminalSize.js";
import { useMouse } from "./useMouse.js";
import { copyToClipboard } from "./clipboard.js";
import { BACKDROP, PANEL, BORDER, MUTED, CYAN, YELLOW, GREEN, RED } from "./theme.js";

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

// repoDir note: the draft is already written straight into the shard's
// working tree on disk the moment it verifies (scriptedWork.ts's own
// writeFilesToWorkingTree) -- a plain file write, not a git commit. You
// can `cd` there right now in another terminal and look at/run it;
// /commit is what turns it into a real changeset (a git commit,
// server-side, plus the matching Ladder rungs), not what first puts it
// on disk.
function formatFreshProposal(p: ContributorProposal["proposal"], repoDir: string): string {
  const filesBlock = p.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  return `${p.summary}\n(commit message: "${p.message}")\n\nWritten to ${repoDir} -- cd there to inspect or test it. /commit turns this into a real changeset.\n\n${filesBlock}`;
}

function formatRevisedProposal(previous: ContributorProposal["proposal"], p: ContributorProposal["proposal"], repoDir: string): string {
  const diff = diffFileSets(previous.files, p.files);
  return `${p.summary}\n(commit message: "${p.message}")\n\nRewritten to ${repoDir}.\n\n${diff || "(no file changes)"}`;
}

function formatDecision(d: ReviewProposal): string {
  return `Decision: ${d.decision}\nReason: ${d.reason}`;
}

const roleLabel: Record<TranscriptEntry["role"], string> = { assistant: "model", user: "you", system: "system" };
const roleColor: Record<TranscriptEntry["role"], string> = { assistant: GREEN, user: CYAN, system: RED };

interface Line {
  text: string;
  color?: string;
  bold?: boolean;
}

/** Flattens the transcript (plus the in-flight streaming turn, if any) into individual lines for scroll windowing -- a single entry (a whole file diff, several files) can be many lines, and TabView's own convention (see its header comment) scrolls by line, not by entry. */
function transcriptLines(entries: TranscriptEntry[], live: { label: string; text: string } | null): Line[] {
  const lines: Line[] = [];
  for (const e of entries) {
    lines.push({ text: `${roleLabel[e.role]}:`, color: roleColor[e.role], bold: true });
    for (const l of e.content.split("\n")) lines.push({ text: l });
    lines.push({ text: "" });
  }
  if (live) {
    lines.push({ text: `${live.label}:`, color: YELLOW, bold: true });
    for (const l of live.text.split("\n")) lines.push({ text: l });
  }
  return lines;
}

/** The full transcript as plain text, for ctrl+y's copy-to-clipboard -- there's no mouse-drag text selection available while the alt-screen mouse-reporting TUI owns the mouse (Option/Shift-drag still works, a standard terminal convention, but isn't discoverable), so this is the one-keystroke way to get a path, a diff, or anything else the model printed onto the real system clipboard. */
function transcriptPlainText(entries: TranscriptEntry[]): string {
  return entries.map((e) => `${roleLabel[e.role]}: ${e.content}`).join("\n\n");
}

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
  const [scroll, setScroll] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const { rows, columns } = useTerminalSize();
  // Fixed rows outside the scrollable content box: header (1 -- always
  // exactly one line, wrap="truncate-end" below guarantees it, which
  // is the whole point of keeping the ask's own description OUT of
  // this header and in the scrollable log instead, see pushEntry below).
  // The content box itself is sized by Yoga's own flexGrow (see its
  // `flexGrow={1}` below), not a hand-computed height -- that's what
  // makes it correctly fill whatever's actually left after the other
  // (fixed, one-line-each) rows, on any terminal size, including one
  // too small to fit a hardcoded guess. This row count is only ever
  // used for JS-side pagination math (how many lines a Page Up jumps,
  // how big the ctrl+y-free scroll window is) -- getting it slightly
  // wrong just changes how far one page-scroll moves, not whether
  // anything fits on screen.
  const CHROME_ROWS = 8; // header(1) + border(2) + status(1) + input(1) + footer(1) + a little slack for Yoga's own rounding
  const innerRows = Math.max(1, rows - CHROME_ROWS);
  const pageSize = Math.max(1, innerRows - 1);

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

  // Snap back to the live edge (scroll=0) whenever a new turn actually
  // lands -- not on every streaming token (that would make scrolling up
  // mid-stream pointless, since the view would yank back down on the
  // very next token), just when pushEntry's array actually grows.
  useEffect(() => {
    setScroll(0);
  }, [entries.length]);

  const scrollUp = () => setScroll((s) => s + 1);
  const scrollDown = () => setScroll((s) => Math.max(0, s - 1));
  useMouse({ onWheelUp: scrollUp, onWheelDown: scrollDown });

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(id);
  }, [flash]);

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
    // The full ask description lives here, in the scrollable log, not
    // in the fixed header above it -- a header whose height depends on
    // how long a task description happens to be is exactly what broke
    // the layout on a small terminal before (see CHROME_ROWS' own
    // comment).
    setEntries([
      { role: "system", content: `Task: ${describeAsk(selected.ask)}` },
      ...(selected.alreadyClaimed ? [{ role: "system" as const, content: "Resuming -- you already hold this claim. Drafting against the current state of your shard." }] : []),
    ]);
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
            pushEntry("assistant", formatFreshProposal(res.result.proposal, res.result.resolved.repoDir));
            setStatus("type feedback, /submit, /commit, /deny [reason], /release, or esc to pause");
          }
        } else {
          setStatus("preparing the files for review...");
          const workspace = await modeRun(() => prepareReviewWorkspace(flowOpts));
          if (cancelled) return;
          pushEntry("system", `Written to ${workspace.repoDir} -- cd there to browse or test it.\n\n${workspace.diff}`);
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
        pushEntry("system", `Real changeset ${committed.shardSource?.commitOid.slice(0, 10)} committed. Still claimed -- /submit when ready, or pause (esc) and come back any time; this is saved history now, not just a file on disk.`);
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
      pushEntry("system", cmd === "approve" ? "Approved." : "Requested changes -- posted a new work ask with your feedback and the rejected draft, claimable by anyone (the original contributor or someone else) to revise.");
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
          pushEntry("assistant", formatFreshProposal(res.result.proposal, res.result.resolved.repoDir));
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
          pushEntry("assistant", formatRevisedProposal(previous, res.result.proposal, res.result.resolved.repoDir));
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
    // ctrl+y, not a bare "y" -- a bare key would be indistinguishable
    // from someone typing the letter "y" into a chat message (the same
    // reason scroll deliberately never uses j/k either), and this needs
    // to work regardless of phase/busy/done, unlike everything below.
    if (key.ctrl && input === "y") {
      if (phase === "picking") {
        const c = claimableList[cursor];
        if (c) {
          copyToClipboard(`[${c.ask.kind}] ${c.repo}\n${describeAsk(c.ask)}`);
          setFlash("copied to clipboard");
        }
      } else {
        copyToClipboard(transcriptPlainText(entries));
        setFlash("copied the transcript to clipboard");
      }
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
    // session phase -- scrolling (arrows/Page Up/Down/Home/End) always
    // available, independent of busy/done, and deliberately never j/k
    // (those are free characters in a chat message here, unlike
    // TabView's own read-only content panes).
    if (key.upArrow) {
      scrollUp();
      return;
    }
    if (key.downArrow) {
      scrollDown();
      return;
    }
    if (key.pageUp) {
      setScroll((s) => s + pageSize);
      return;
    }
    if (key.pageDown) {
      setScroll((s) => Math.max(0, s - pageSize));
      return;
    }
    if (key.home) {
      setScroll(Number.MAX_SAFE_INTEGER); // clamped to the real max when rendered
      return;
    }
    if (key.end) {
      setScroll(0);
      return;
    }
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
    // Estimate only, for pagination math (how many items fit around the
    // cursor) -- the box itself is sized by Yoga's own flexGrow below,
    // same reasoning as the session view's own innerRows.
    const pickerInnerRows = Math.max(1, rows - 4);
    // Windowed around the cursor -- rendering every claimable ask
    // unconditionally overflowed a small terminal's actual height
    // before, which is a big part of what made the whole picker look
    // broken there.
    const windowStart = Math.max(0, Math.min(cursor - Math.floor(pickerInnerRows / 2), Math.max(0, claimableList.length - pickerInnerRows)));
    const visible = claimableList.slice(windowStart, windowStart + pickerInnerRows);
    return (
      <Box flexDirection="column" width={columns} height={rows} backgroundColor={BACKDROP}>
        <Box backgroundColor={PANEL} paddingX={1}>
          <Text bold color={CYAN} wrap="truncate-end">
            zz work --assist -- pick an ask ({backend.name})
          </Text>
        </Box>
        <Box borderStyle="round" borderColor={BORDER} flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
          {claimableList.length === 0 ? (
            <Text color={MUTED}>No claimable work/changeset_review asks right now across your watched repos. (refreshing every 2s)</Text>
          ) : (
            visible.map((c, i) => {
              const idx = windowStart + i;
              return (
                <Box key={c.ask.id}>
                  <Text bold={idx === cursor} color={idx === cursor ? CYAN : undefined}>
                    {idx === cursor ? "> " : "  "}
                  </Text>
                  <Text color={c.ask.kind === "work" ? YELLOW : GREEN}>[{c.ask.kind}]</Text>
                  <Text bold={idx === cursor} color={idx === cursor ? CYAN : undefined}>
                    {" "}
                    {c.repo}
                  </Text>
                  {c.alreadyClaimed && <Text color={MUTED}> (claimed)</Text>}
                  <Text color={MUTED} wrap="truncate-end">
                    {" "}
                    -- {describeAsk(c.ask)}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>
        <Box>
          <Text color={flash ? GREEN : MUTED} wrap="truncate-end">
            {flash ?? "↑/↓ select enter: start ctrl+y: copy q/ctrl+c: quit"}
          </Text>
        </Box>
      </Box>
    );
  }

  const liveTurn = liveText ? { label: liveLabel, text: liveText } : null;
  const allLines = transcriptLines(entries, liveTurn);
  const windowSize = innerRows;
  const maxOffset = Math.max(0, allLines.length - windowSize);
  const offset = Math.min(scroll, maxOffset);
  const end = allLines.length - offset;
  const shown = allLines.slice(Math.max(0, end - windowSize), end);

  return (
    <Box flexDirection="column" width={columns} height={rows} backgroundColor={BACKDROP}>
      <Box backgroundColor={PANEL} paddingX={1}>
        <Text bold color={CYAN} wrap="truncate-end">
          {selected?.ask.kind} {selected?.ask.id} in {selected?.repo}/{selected?.laneId} ({backend.name})
        </Text>
      </Box>
      <Box borderStyle="round" borderColor={BORDER} flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
        {offset > 0 && <Text color={MUTED}>-- {offset} line(s) back (End to catch up) --</Text>}
        {shown.map((l, i) => (
          <Text key={i} color={l.color} bold={l.bold} wrap="truncate-end">
            {l.text || " "}
          </Text>
        ))}
      </Box>
      <Text color={flash ? GREEN : busy ? YELLOW : MUTED} wrap="truncate-end">
        {flash ?? status}
      </Text>
      {!done && (
        <Box width={columns}>
          <Text color={MUTED}>{"> "}</Text>
          <Text wrap="truncate-start">{inputValue}</Text>
          <Text color={MUTED}>{busy ? "" : "_"}</Text>
        </Box>
      )}
      {done && <Text color={MUTED}>enter/esc: back to the ask list</Text>}
      <Box>
        <Text color={MUTED} wrap="truncate-end">
          ↑/↓ PgUp/PgDn Home/End or wheel: scroll ctrl+y: copy esc: pause ctrl+c: quit
        </Text>
      </Box>
    </Box>
  );
}
