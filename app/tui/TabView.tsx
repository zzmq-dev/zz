// A real full-screen tabbed frame: fixed to the terminal's actual size
// (see useTerminalSize) with a bordered content pane sized to fit, so
// nothing spills into scrollback. Left/right arrows (or h/l), 1-9, or
// clicking a tab's label switches tabs; up/down arrows (or k/j), Page
// Up/Down, Home/End, and the mouse wheel scroll the active tab's
// content -- each content renderer decides what a given scroll offset
// actually means (older entries for a log, earlier rows for a list)
// since that differs per view. y copies the active tab's full
// (untruncated) content to the system clipboard. q or Ctrl+C quits
// (restoring the normal screen first).
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { spawn } from "node:child_process";
import { useTerminalSize } from "./useTerminalSize.js";
import { useMouse } from "./useMouse.js";
import { exitFullscreen } from "./fullscreen.js";
import { BACKDROP, PANEL, BORDER, MUTED, PINK } from "./theme.js";

export interface Tab {
  label: string;
  /** Given how many rows are available and the current scroll offset (0 = latest/top), render this tab's content sized to fit. */
  content: (maxRows: number, scrollOffset: number) => React.ReactNode;
  /** The full, untruncated text of this tab right now -- used by the "y" copy-to-clipboard key. Omit for a tab that has nothing meaningful to copy as plain text. */
  getFullText?: () => string;
}

const CHROME_ROWS = 5; // title/tab bar (1) + blank (1) + content box border (2) + footer (1)
const TAB_BAR_ROW = 1; // the tab bar is the very first rendered line

function copyToClipboard(text: string): void {
  // macOS only, matching this project's one supported platform -- pipe
  // directly into pbcopy's stdin rather than shelling through a string.
  const proc = spawn("pbcopy");
  proc.stdin.write(text);
  proc.stdin.end();
}

// Where each tab's clickable label actually sits on screen, in 1-indexed
// terminal columns -- has to mirror the real layout below exactly
// (title, then a 2-space gap, then each "N:label" with a 2-space
// marginRight) since that's the only way to turn a raw click column
// back into "which tab was that".
function tabClickRanges(title: string, tabs: Tab[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let col = title.length + 1 + 2; // title, then the "  " gap after it
  for (let i = 0; i < tabs.length; i++) {
    const label = `${i + 1}:${tabs[i].label}`;
    ranges.push({ start: col, end: col + label.length - 1 });
    col += label.length + 2; // + marginRight={2}
  }
  return ranges;
}

export function TabView({
  title,
  tabs,
  onExit,
  inputPaused,
  initialTab,
}: {
  title: string;
  tabs: Tab[];
  onExit?: () => Promise<void> | void;
  /** True while the active tab's own content owns the keyboard (e.g. Explore's search box mid-query) -- every single-character hotkey below (q/h/l/y/digits) would otherwise collide with free-text typing. TabView's own scroll/tab-switch/quit/copy keys are suppressed entirely until this goes back to false; the content itself is responsible for its own escape hatch back out of that state. */
  inputPaused?: boolean;
  /** Which tab is active on first render -- defaults to 0 (unchanged for every existing caller). zz top's own Explore tab is always tabs[0] (reachable at any time, regardless of which tab opens first) but should only be the one that actually opens first when there's nothing else to show yet (see TopApp.tsx). */
  initialTab?: number;
}) {
  const [active, setActive] = useState(initialTab ?? 0);
  const [scroll, setScroll] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const { isRawModeSupported } = useStdin();
  const { rows, columns } = useTerminalSize();
  const contentHeight = Math.max(3, rows - CHROME_ROWS);
  const pageSize = Math.max(1, contentHeight - 2);

  useEffect(() => setScroll(0), [active]);
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(id);
  }, [flash]);

  const scrollUp = () => setScroll((s) => s + 1);
  const scrollDown = () => setScroll((s) => Math.max(0, s - 1));
  useMouse({
    onWheelUp: scrollUp,
    onWheelDown: scrollDown,
    onClick: (col, row) => {
      if (row !== TAB_BAR_ROW) return;
      const ranges = tabClickRanges(title, tabs);
      const clicked = ranges.findIndex((r) => col >= r.start && col <= r.end);
      if (clicked >= 0) setActive(clicked);
    },
  });

  useInput(
    (input, key) => {
      // Ctrl+C always quits, even mid-typing -- everything else below
      // is a single-character hotkey that would otherwise collide
      // with free-text entry in whatever's capturing input right now.
      if (inputPaused && !(key.ctrl && input === "c")) return;
      if (input === "q" || (key.ctrl && input === "c")) {
        // Raw mode swallows the OS-level SIGINT translation for a
        // keypress, so this is the only place Ctrl+C is ever actually
        // observed in the TUI -- any process-level exit cleanup (e.g.
        // `zz work --as <name>` revoking its session's token) has to
        // run here, not in a process.on("SIGINT", ...) handler, which
        // this keypress never triggers.
        void Promise.resolve(onExit?.()).finally(() => {
          exitFullscreen();
          process.exit(0);
        });
        return;
      }
      if (key.rightArrow || input === "l") setActive((i) => (i + 1) % tabs.length);
      else if (key.leftArrow || input === "h") setActive((i) => (i - 1 + tabs.length) % tabs.length);
      else if (key.upArrow || input === "k") scrollUp();
      else if (key.downArrow || input === "j") scrollDown();
      else if (key.pageUp) setScroll((s) => s + pageSize);
      else if (key.pageDown) setScroll((s) => Math.max(0, s - pageSize));
      else if (key.home) setScroll(Number.MAX_SAFE_INTEGER);
      else if (key.end) setScroll(0);
      else if (input === "y") {
        const getFullText = tabs[active]?.getFullText;
        if (getFullText) {
          copyToClipboard(getFullText());
          setFlash(`copied "${tabs[active].label}" tab to clipboard`);
        } else {
          setFlash(`nothing to copy on the "${tabs[active]?.label}" tab`);
        }
      } else {
        const n = Number(input);
        if (Number.isInteger(n) && n >= 1 && n <= tabs.length) setActive(n - 1);
      }
    },
    { isActive: isRawModeSupported },
  );

  return (
    <Box flexDirection="column" width={columns} height={rows} backgroundColor={BACKDROP}>
      <Box backgroundColor={PANEL} paddingX={1}>
        <Text bold color={PINK}>
          {title}
        </Text>
        <Text>{"  "}</Text>
        {tabs.map((t, i) => (
          <Box key={t.label} marginRight={2}>
            <Text bold={i === active} color={i === active ? PINK : MUTED} underline={i === active}>
              {i + 1}:{t.label}
            </Text>
          </Box>
        ))}
      </Box>
      <Box borderStyle="round" borderColor={BORDER} flexDirection="column" height={contentHeight} overflow="hidden" paddingX={1}>
        {tabs[active]?.content(pageSize, scroll)}
      </Box>
      <Box>
        <Text color={MUTED}>
          {flash ?? (isRawModeSupported ? "←/→ or 1-9 or click: tabs   ↑/↓ wheel PgUp/PgDn Home/End: scroll   y: copy tab   q: quit" : "(non-interactive terminal -- controls disabled)")}
        </Text>
      </Box>
    </Box>
  );
}
